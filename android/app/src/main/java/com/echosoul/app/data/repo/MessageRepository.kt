package com.echosoul.app.data.repo

import com.echosoul.app.api.ChatRequest
import com.echosoul.app.api.Client
import com.echosoul.app.app.AppConfig
import com.echosoul.app.data.local.CachedMessage
import com.echosoul.app.data.local.DraftDao
import com.echosoul.app.data.local.DraftRow
import com.echosoul.app.data.local.MessageCacheDao
import com.echosoul.app.data.local.OutboxDao
import com.echosoul.app.data.local.OutboxRow
import com.echosoul.app.data.model.ChatStreamEvent
import com.echosoul.app.data.remote.SseFrame
import com.echosoul.app.data.remote.SupabaseData
import com.echosoul.app.data.remote.strOr
import com.echosoul.app.diagnostic.Diagnostics
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/**
 * 消息 Repository：本地渲染缓存 + 分页拉取 + 一轮对话的收尾落库。
 *
 * 三条铁律写在这里，别处不必重复：
 *   1. **本地缓存不是真源**（分册 §10）：可随时清空，真源永远是 Postgres messages 表。
 *   2. **去重按服务端 id**：补发与实时推送可能同时到（§5.4），id 相同即同一条。
 *   3. **幂等键复用**：重试（无论网络还是用户点「继续」）必须带同一个 idempotency_key，
 *      换键 = 服务端重复扣费（架构 §2.1）。所以离队消息的 key 在入队那刻就定死。
 */
@Singleton
class MessageRepository @Inject constructor(
    private val remote: SupabaseData,
    private val cache: MessageCacheDao,
    private val drafts: DraftDao,
    private val outbox: OutboxDao,
    private val diagnostics: Diagnostics,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val json = Json { ignoreUnknownKeys = true }

    /** 当前会话的消息流。UI 直接 collect 它即可，无需自己 merge 多个来源。 */
    fun messages(sessionId: String): Flow<List<CachedMessage>> = cache.observeSession(sessionId)

    fun draft(sessionId: String): Flow<String?> = drafts.observeText(sessionId)

    fun outboxCount(): Flow<Int> = outbox.observeCount()

    suspend fun saveDraft(sessionId: String, text: String) = withContext(Dispatchers.IO) {
        if (text.isBlank()) drafts.clear(sessionId) else drafts.put(DraftRow(sessionId, text))
    }

    /**
     * 更早一页。返回是否还有更多。
     *
     * 分页游标用**服务端返回的第一条的 created_at**（before 参数），不用本地缓存的——
     * 本地可能被 LRU 裁过，拿它当游标会跳过中间一段。
     */
    suspend fun loadOlder(sessionId: String): Boolean = withContext(Dispatchers.IO) {
        val oldest = cache.latest(sessionId, 1).firstOrNull()?.createdAt
        val rows = runCatching { remote.pageMessages(sessionId, oldest) }.getOrElse { e ->
            diagnostics.debug("msg", "page failed ${e.javaClass.simpleName}")
            return@withContext false
        }
        val cached = rows.map { it.toMessageRow().toCached(sessionId, System.currentTimeMillis()) }
        cache.backfillAndPrune(cached, AppConfig.Cache.MESSAGES_PER_SESSION)
        rows.size >= PAGE_SIZE
    }

    /** 首屏：本地有就先显示本地，网络回来的整表覆盖（服务端落库版本优先）。 */
    suspend fun refreshFirstPage(sessionId: String) = withContext(Dispatchers.IO) {
        val rows = runCatching { remote.pageMessages(sessionId, before = null) }.getOrElse { e ->
            diagnostics.debug("msg", "first page failed ${e.javaClass.simpleName}")
            return@withContext
        }
        val cached = rows.map { it.toMessageRow().toCached(sessionId, System.currentTimeMillis()) }
        cache.cacheAndPrune(cached, AppConfig.Cache.MESSAGES_PER_SESSION)
    }

    suspend fun markRead(sessionId: String) = withContext(Dispatchers.IO) {
        runCatching {
            remote.markRead(sessionId)
            // 本地也标一次，列表红点立即消失，不等下次拉取。
            cache.markAllRead(sessionId, com.echosoul.app.data.local.Timestamps.formatIsoUtc(System.currentTimeMillis()))
        }
    }

    /**
     * 发一条消息。
     *
     * ★ 这里**只负责发**，不在这里拼接流式结果 —— 流式由 ViewModel 收集
     *   [SupabaseData.streamChat] 的 Flow，reason 是"停止收集 ≠ 取消请求"这条坑
     *   （ChatSseClient 的 awaitClose 注释），生命周期须由持有 UI 的那层管。
     *
     * 返回 event 流：meta/delta/done/failed/transport，与契约 ChatStreamEvent 对齐。
     */
    fun send(sessionId: String, content: String, idempotencyKey: String, providerProfileId: String?, providerKind: String?): Flow<ChatStreamEvent> {
        val request = ChatRequest(
            session_id = sessionId,
            content = content,
            idempotency_key = idempotencyKey,
            client = Client.ANDROID,
            provider = if (providerProfileId != null && providerKind != null) {
                com.echosoul.app.api.ByokRef(
                    kind = com.echosoul.app.api.ProviderKind.values()
                        .firstOrNull { it.wire == providerKind } ?: com.echosoul.app.api.ProviderKind.OPENAI,
                    profile_id = providerProfileId,
                )
            } else {
                null
            },
        )
        return remote.streamChat(request).map { it.toEvent() }
    }

    /** 「继续」：同一轮被切断后用服务端已落库的 message id 续写。 */
    fun resume(messageId: String): Flow<ChatStreamEvent> =
        remote.resumeChat(messageId).map { it.toEvent() }

    /**
     * 离线入队：用户消息先进本地队列，恢复后按**原幂等键**重发。
     * 幂等键在入队这一刻生成，之后所有重试复用它（分册 §4）。
     */
    suspend fun enqueueOutbox(sessionId: String, content: String, providerProfileId: String?, providerKind: String?): Unit =
        withContext(Dispatchers.IO) {
            outbox.enqueue(
                OutboxRow(
                    id = UUID.randomUUID().toString(),
                    sessionId = sessionId,
                    content = content,
                    idempotencyKey = UUID.randomUUID().toString(),
                    providerProfileId = providerProfileId,
                    providerKind = providerKind,
                ),
            )
        }

    /**
     * 把服务端落库版本覆盖本地流式拼接结果。
     * 拿到 done 之后调用：流式期间 UI 自己拼的临时气泡在这里被真身替换。
     */
    suspend fun cacheServerVersions(sessionId: String, rows: List<JsonObject>) = withContext(Dispatchers.IO) {
        val cached = rows.map { it.toMessageRow().toCached(sessionId, System.currentTimeMillis()) }
        cache.cacheAndPrune(cached, AppConfig.Cache.MESSAGES_PER_SESSION)
    }

    private fun SseFrame.toEvent(): ChatStreamEvent = when (event) {
        "meta" -> runCatching {
            ChatStreamEvent.Meta(json.decodeFromString(com.echosoul.app.api.ChatMeta.serializer(), data))
        }.getOrElse { ChatStreamEvent.Transport("meta 解析失败", partial = true) }
        "delta" -> runCatching {
            ChatStreamEvent.Delta(json.decodeFromString(com.echosoul.app.api.ChatDelta.serializer(), data).t)
        }.getOrElse { ChatStreamEvent.Transport("delta 解析失败", partial = true) }
        "done" -> runCatching {
            ChatStreamEvent.Done(json.decodeFromString(com.echosoul.app.api.ChatDone.serializer(), data))
        }.getOrElse { ChatStreamEvent.Done(com.echosoul.app.api.ChatDone()) }
        "error" -> runCatching {
            val o = json.parseToJsonElement(data)
            ChatStreamEvent.Failed(
                com.echosoul.app.api.ChatError(
                    code = when (o) {
                        is JsonObject -> o.strOr("code", "UPSTREAM_5XX")
                        else -> "UPSTREAM_5XX"
                    },
                    msg = when (o) {
                        is JsonObject -> o.strOr("msg", "刚才没成功，再试一次。")
                        else -> "刚才没成功，再试一次。"
                    },
                    partial = when (o) {
                        is JsonObject -> o["partial"]?.toString()?.toBooleanStrictOrNull()
                        else -> null
                    },
                ),
            )
        }.getOrElse { ChatStreamEvent.Transport("error 解析失败", partial = true) }
        else -> ChatStreamEvent.Transport("未知事件 ${event}", partial = true)
    }

    companion object {
        /** 与服务端 page_messages 默认分页一致；小于它会多花一个来回。 */
        const val PAGE_SIZE = 40
    }
}
