package com.echosoul.app.realtime

import com.echosoul.app.app.AppConfig
import com.echosoul.app.data.local.Timestamps
import com.echosoul.app.data.remote.HttpEngine
import com.echosoul.app.diagnostic.Diagnostics
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

/**
 * 自建长连接客户端（定案 F2：不走厂商通道）。
 *
 * 连接的是 Supabase Realtime 的 WebSocket（wss://<proj>.supabase.co/realtime/v1/websocket），
 * 账号级频道只订**推送信封**（"有新消息"，带 message id + session id），
 * **不订消息正文** —— 正文永远回数据库取（§5.1 铁律：先写库再推送）。
 * 这样即使推送内容丢了/顺序乱了，客户端回查一次就补齐，不会显示错内容。
 *
 * 心跳 25s（NAT 超时通常 30–60s，见 AppConfig.Realtime）。失败 3 次进指数退避（1s→…→5min 封顶）。
 *
 * ★ 生命周期：不在这里自持重连线程的生命周期判断，由持有者（RealtimeService）
 *   调 [start]/[stop]。本类只管"连上→收帧→断了按退避重连"。
 */
@Singleton
class RealtimeClient @Inject constructor(
    private val http: HttpEngine,
    private val diagnostics: Diagnostics,
) {
    private val _events = MutableSharedFlow<RealtimeEvent>(
        extraBufferCapacity = 64,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    val events: SharedFlow<RealtimeEvent> = _events.asSharedFlow()

    private val _state = MutableSharedFlow<ConnectionState>(
        replay = 1,
        extraBufferCapacity = 4,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    val state: SharedFlow<ConnectionState> = _state.asSharedFlow()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Volatile private var socket: WebSocket? = null
    @Volatile private var running = false
    private var heartbeatJob: Job? = null
    private var connectJob: Job? = null
    private val intentionalClose = AtomicBoolean(false)

    /** 客户端 OkHttp：读超时设 0（长连接本来就不该被读超时掐），靠心跳判活。 */
    private val client: OkHttpClient by lazy {
        http.client.newBuilder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(0, TimeUnit.MILLISECONDS) // 心跳自己发应用层 ping，不用 OkHttp 的协议 ping
            .retryOnConnectionFailure(true)
            .build()
    }

    fun start() {
        if (running) return
        running = true
        connectJob = scope.launch { connectLoop() }
    }

    fun stop() {
        running = false
        intentionalClose.set(true)
        heartbeatJob?.cancel()
        socket?.close(NORMAL_CLOSE, "bye")
        socket = null
        connectJob?.cancel()
        connectJob = null
    }

    /** 用户点「重连」或系统恢复网络时调用：跳过退避直接重连。 */
    fun reconnectNow() {
        if (!running) { start(); return }
        socket?.cancel()
        heartbeatJob?.cancel()
        connectJob?.cancel()
        connectJob = scope.launch { connectLoop() }
    }

    // ─── 连接主循环：带指数退避 ───
    private suspend fun connectLoop() {
        var attempt = 0
        while (scope.isActive && running) {
            intentionalClose.set(false)
            _state.tryEmit(ConnectionState.Connecting(attempt))
            val closed = connectOnce()
            if (!running || intentionalClose.get()) {
                _state.tryEmit(ConnectionState.Stopped)
                return
            }
            _state.tryEmit(ConnectionState.Disconnected(closed.reason))
            // 指数退避：1s * 2^n，封顶 5min。attempt 上限防止 1 shl 溢出。
            attempt = (attempt + 1).coerceAtMost(MAX_BACKOFF_SHIFT)
            val delayMs = (AppConfig.Realtime.BACKOFF_BASE_MS shl (attempt - 1))
                .coerceAtMost(AppConfig.Realtime.BACKOFF_CAP_MS)
            diagnostics.debug("rt", "reconnect in ${delayMs}ms (attempt=$attempt)")
            kotlinx.coroutines.delay(delayMs)
        }
    }

    private suspend fun connectOnce(): CloseInfo {
        val url = realtimeUrl() ?: return CloseInfo("no session")
        val request = Request.Builder().url(url).build()
        val latch = kotlinx.coroutines.CompletableDeferred<CloseInfo>()

        val ws = client.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    socket = webSocket
                    _state.tryEmit(ConnectionState.Connected)
                    startHeartbeat(webSocket)
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    handleFrame(text)
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(NORMAL_CLOSE, null)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    heartbeatJob?.cancel()
                    socket = null
                    if (!latch.isCompleted) latch.complete(CloseInfo("closed $code"))
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    heartbeatJob?.cancel()
                    socket = null
                    diagnostics.debug("rt", "ws failure ${t.javaClass.simpleName}")
                    if (!latch.isCompleted) latch.complete(CloseInfo("failure ${t.javaClass.simpleName}"))
                }
            },
        )
        socket = ws
        return latch.await()
    }

    /**
     * 应用层心跳：每 25s 发一条 heartbeat 帧；连续 miss 达阈值就判死并主动断开重连。
     * 为什么不用 OkHttp 的 pingInterval：那是协议级 ping/pong，Supabase Realtime
     * 需要的是它自己的应用层 heartbeat 消息，否则服务端会按自己的 interval 把我们踢掉。
     */
    private fun startHeartbeat(webSocket: WebSocket) {
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            var missed = 0
            while (isActive) {
                kotlinx.coroutines.delay(AppConfig.Realtime.HEARTBEAT_MS)
                val ok = webSocket.send(HEARTBEAT_FRAME)
                if (!ok) missed++ else missed = 0
                if (missed >= AppConfig.Realtime.MAX_MISSED_PONGS) {
                    diagnostics.debug("rt", "heartbeat missed, reconnect")
                    webSocket.cancel()
                    return@launch
                }
                _state.tryEmit(ConnectionState.Heartbeat)
            }
        }
    }

    /**
     * 帧解析：只认两种我们关心的帧
     *   - `system`  / `phx_reply` 心跳回应 → 忽略（只是保活）
     *   - `postgres_changes` / 自定义 `push` 事件 → 转成 [RealtimeEvent.NewMessage]
     *
     * ★ 未知帧一律丢弃并 debug 记录，不抛异常：服务端加事件类型不该让旧客户端断线。
     */
    private fun handleFrame(text: String) {
        runCatching {
            val obj = JSONObject(text)
            val event = obj.optString("event")
            when (event) {
                "[object Object]", "system" -> Unit
                "message", "push", "postgres_changes" -> parsePayload(obj)
                else -> {
                    // Phoenix 心跳回应是 {"event":"phx_reply",...}
                    if (event.startsWith("phx")) return@runCatching
                    parsePayload(obj)
                }
            }
        }.onFailure { e ->
            diagnostics.debug("rt", "bad frame ${e.javaClass.simpleName}")
        }
    }

    private fun parsePayload(obj: JSONObject) {
        val payload = obj.optJSONObject("payload") ?: return
        // 服务端下发的信封可能是 {type:"new_message", message_id, session_id, created_at}
        val type = payload.optString("type")
        if (type != "new_message" && type != "message") return
        val messageId = payload.optString("message_id").ifBlank { payload.optString("id") }
        val sessionId = payload.optString("session_id")
        val createdAt = payload.optString("created_at")
        if (messageId.isBlank() || sessionId.isBlank()) return
        _events.tryEmit(
            RealtimeEvent.NewMessage(
                messageId = messageId,
                sessionId = sessionId,
                createdAt = createdAt,
                serverTimestampMs = Timestamps.parseMillis(createdAt),
            ),
        )
    }

    /** 长连接 URL：带 apikey 与 access_token（RLS 决定订阅哪个账号的频道）。 */
    private suspend fun realtimeUrl(): String? {
        val token = runCatching { http.currentToken() }.getOrNull() ?: return null
        val base = AppConfig.supabaseUrl
            .replaceFirst("https://", "wss://")
            .replaceFirst("http://", "ws://")
        return "$base/realtime/v1/websocket?apikey=${AppConfig.anonKey}&vsn=1.0.0&access_token=$token"
    }

    private companion object {
        const val NORMAL_CLOSE = 1000
        const val MAX_BACKOFF_SHIFT = 9 // 1s << 8 = 256s, 再封顶 300s
        val HEARTBEAT_FRAME = """{"topic":"phoenix","event":"heartbeat","payload":{},"ref":null}"""
    }

    private data class CloseInfo(val reason: String)
}

/** 长连接收到的一条事件。信封只带 id，正文回库取。 */
sealed interface RealtimeEvent {
    data class NewMessage(
        val messageId: String,
        val sessionId: String,
        val createdAt: String,
        val serverTimestampMs: Long?,
    ) : RealtimeEvent
}

/** 连接状态机，供前台服务更新通知文案、供 UI 显示"连接中/已断开"。 */
sealed interface ConnectionState {
    data class Connecting(val attempt: Int) : ConnectionState
    data object Connected : ConnectionState
    data object Heartbeat : ConnectionState
    data class Disconnected(val reason: String) : ConnectionState
    data object Stopped : ConnectionState
}
