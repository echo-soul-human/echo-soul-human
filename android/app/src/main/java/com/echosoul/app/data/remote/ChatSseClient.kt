package com.echosoul.app.data.remote

import com.echosoul.app.app.AppConfig
import java.io.IOException
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONObject

/**
 * SSE 帧。event 名来自服务端 send('meta'|'delta'|'done'|'error')，data 是它的实参。
 * 未知事件名保留而不丢弃：服务端以后加事件类型时，旧客户端不该静默丢数据。
 */
data class SseFrame(val event: String, val data: String)

/**
 * ChatSseClient — OkHttp + callbackFlow 的流式对话客户端（分册 §4）。
 *
 * 四条不能省的规矩（与网页 lib/sse.ts 逐条对齐）：
 *   1. **半帧必须缓冲**：一个帧可能被 TCP 拆成两次到达，没等到空行的部分留在 buffer 里。
 *   2. **停止收集 ≠ 取消请求**：见 [stream] 的 awaitClose 注释。在 ViewModel 销毁时
 *      cancel() 会中断服务端生成 —— 这是这个项目最容易踩的坑（分册 §4 ⚠️）。
 *   3. 读超时给足（streamingClient = 120s），否则长回答被掐。
 *   4. 传输失败也要吐 error 帧，让上层能区分"有部分内容可保留"和"什么都没有"。
 */
@Singleton
class ChatSseClient @Inject constructor(
    private val http: HttpEngine,
) {
    private val client: OkHttpClient by lazy {
        http.client.newBuilder()
            .readTimeout(AppConfigTimeouts.READ_MS.toLong(), TimeUnit.MILLISECONDS)
            .callTimeout(0L, TimeUnit.MILLISECONDS)
            .retryOnConnectionFailure(false) // 重试由调用方带同一 idempotency_key 决定，不能让 OkHttp 自作主张
            .build()
    }

    /**
     * 发起一次流式调用。返回的 Flow 在流结束（done / error / 传输断开）后正常完成，
     * **不抛异常**：断流时可能已有部分内容需要保留显示。
     *
     * @param cancelsOnClose 默认 **false**。收集端消失（页面划走、ViewModel onCleared）
     *   绝不取消 HTTP call —— 服务端仍在生成并落库，取消等于让用户丢掉已经付过钱的回复
     *   （分册 §4 ⚠️ 点名的坑）。只有用户明确点「停下」时才传 true。
     */
    fun stream(
        url: String,
        bodyJson: String,
        acceptEventTypes: Set<String>? = null,
        cancelsOnClose: Boolean = false,
    ): Flow<SseFrame> = callbackFlow {
            val token = runCatching { http.currentToken() }.getOrNull()
            if (token == null) {
                trySend(SseFrame(EVENT_ERROR, errorPayload("UNAUTHORIZED", "登录状态过期了，重新登录一下。")))
                close()
                return@callbackFlow
            }
            val request = Request.Builder()
                .url(url)
                .header("Authorization", "Bearer $token")
                .header("accept", "text/event-stream")
                .header("cache-control", "no-cache")
                .post(http.jsonBody(bodyJson))
                .build()

            val call = client.newCall(request)
            var sawTerminal = false

            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    // 网络层失败：partial 未知，保守报 false；已显示的文本由上层自己留着。
                    if (!sawTerminal) {
                        trySend(SseFrame(EVENT_ERROR, errorPayload("MODEL_STREAM_BREAK", "说到一半断了。", partial = true)))
                    }
                    close()
                }

                override fun onResponse(call: Call, response: Response) {
                    response.use { res ->
                        if (!res.isSuccessful) {
                            sawTerminal = true
                            trySend(SseFrame(EVENT_ERROR, payloadFromFailure(res)))
                            close()
                            return
                        }
                        val source = res.body?.source()
                        if (source == null) {
                            trySend(SseFrame(EVENT_ERROR, errorPayload("NETWORK", "网络不通，检查一下连接再试。")))
                            close()
                            return
                        }
                        try {
                            var pending = ""
                            while (!source.exhausted()) {
                                val line = source.readUtf8Line() ?: break
                                // 空行 = 一帧结束
                                if (line.isEmpty()) {
                                    val frame = parseFrame(pending, acceptEventTypes)
                                    pending = ""
                                    if (frame != null) {
                                        if (frame.event == EVENT_DONE || frame.event == EVENT_ERROR) sawTerminal = true
                                        trySend(frame)
                                    }
                                    continue
                                }
                                pending = if (pending.isEmpty()) line else "$pending\n$line"
                            }
                            // 收尾残包：服务端偶尔不以空行结尾就关流
                            parseFrame(pending, acceptEventTypes)?.let { frame ->
                                if (frame.event == EVENT_DONE || frame.event == EVENT_ERROR) sawTerminal = true
                                trySend(frame)
                            }
                        } catch (e: IOException) {
                            if (!sawTerminal) {
                                trySend(
                                    SseFrame(
                                        EVENT_ERROR,
                                        errorPayload("MODEL_STREAM_BREAK", "说到一半断了。", partial = true),
                                    ),
                                )
                            }
                        } finally {
                            close()
                        }
                    }
                }
            })

            // ★ awaitClose 默认**不调 call.cancel()**。
            //   收集端消失（页面划走、ViewModel onCleared）不等于用户想中止生成：
            //   服务端还在写库，取消它只会让用户丢一条已经付过钱的回复。
            awaitClose { if (cancelsOnClose) call.cancel() }
        }

    private fun parseFrame(raw: String, accept: Set<String>?): SseFrame? {
        if (raw.isBlank()) return null
        var event = "message"
        val dataLines = ArrayList<String>(2)
        for (line in raw.split('\n')) {
            when {
                line.startsWith("event:") -> event = line.substring(6).trim()
                line.startsWith("data:") -> dataLines.add(line.substring(5).trimStart())
                // id: / retry: 目前不需要
                else -> Unit
            }
        }
        if (dataLines.isEmpty()) return null
        if (accept != null && event !in accept) return null
        return SseFrame(event, dataLines.joinToString("\n"))
    }

    private fun payloadFromFailure(res: Response): String {
        val text = runCatching { res.body?.string().orEmpty() }.getOrDefault("")
        val code = CONTRACT_CODES.firstOrNull { text.contains(it) } ?: when (res.code) {
            401 -> "UNAUTHORIZED"
            402 -> "INSUFFICIENT_BALANCE"
            403 -> "NO_ENTITLEMENT"
            404 -> "SESSION_NOT_FOUND"
            429 -> "RATE_LIMITED"
            else -> "UPSTREAM_5XX"
        }
        return errorPayload(code, messageFor(code))
    }

    private fun errorPayload(code: String, msg: String, partial: Boolean = false): String =
        JSONObject().apply {
            put("code", code)
            put("msg", msg)
            if (partial) put("partial", true)
        }.toString()

    private companion object {
        const val EVENT_DONE = "done"
        const val EVENT_ERROR = "error"
        val CONTRACT_CODES = listOf(
            "NETWORK", "RESUME_FAILED", "MODEL_STREAM_BREAK", "BAD_JSON", "EMPTY_CONTENT",
            "CONTENT_TOO_LONG", "METHOD_NOT_ALLOWED", "UNAUTHORIZED", "NO_ENTITLEMENT",
            "SESSION_NOT_FOUND", "SESSION_EMPTY", "INSUFFICIENT_BALANCE", "LEDGER_ERROR",
            "RATE_LIMITED", "BYOK_NOT_FOUND", "ENDPOINT_BLOCKED", "PROVIDER_CONFIG", "UPSTREAM_5XX",
        )
    }
}

/** 单独放出来避免 ChatSseClient 依赖 AppConfig 常量对象（object 初始化会碰 BuildConfig）。 */
private object AppConfigTimeouts {
    /** 流式必须给足读超时，否则长回答会被掐（分册 §3）。 */
    const val READ_MS = 120_000
}

private fun messageFor(code: String): String = when (code) {
    "INSUFFICIENT_BALANCE" -> "额度用完了，续一下就能继续聊。"
    "UNAUTHORIZED" -> "登录状态过期了，重新登录一下。"
    "RATE_LIMITED" -> "这会儿有点挤，稍等一下再发。"
    "SESSION_NOT_FOUND" -> "这个会话找不到了，刷新看看。"
    "NO_ENTITLEMENT" -> "权益读不到，重新登录一下试试。"
    "MODEL_STREAM_BREAK" -> "说到一半断了。"
    "NETWORK" -> "网络不通，检查一下连接再试。"
    else -> "刚才没成功，再试一次。"
}

/** 供 resume 用的简化入口（chat-resume 与 chat 同构：同一个 SSE 解析器）。 */
fun ChatSseClient.streamResume(messageId: String): Flow<SseFrame> = stream(
    url = AppConfig.functions("chat-resume"),
    bodyJson = buildObject("message_id" to messageId).plain(),
)
