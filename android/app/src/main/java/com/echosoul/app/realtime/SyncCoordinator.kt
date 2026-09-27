package com.echosoul.app.realtime

import com.echosoul.app.app.AppConfig
import com.echosoul.app.data.local.CursorStore
import com.echosoul.app.data.local.MessageCacheDao
import com.echosoul.app.data.local.SettingsStore
import com.echosoul.app.data.local.Timestamps
import com.echosoul.app.data.remote.SupabaseData
import com.echosoul.app.data.repo.HtmlSafe
import com.echosoul.app.diagnostic.Diagnostics
import com.echosoul.app.notif.Notifier
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

/**
 * 消息汇入与补发协调（§5.1 第 2 层 + §5.4 去重）。
 *
 * 两条路径会同时把同一条消息送到客户端：
 *   A. 长连接推送信封（[RealtimeEvent.NewMessage]）→ 触发一次按 id 回查；
 *   B. 回前台 / 兜底同步按 `last_seen_at` 批量补发。
 * 两者都以**服务端 message id** 去重（补发用 INSERT IGNORE，见 MessageCacheDao.insertIgnore）。
 *
 * ★ 游标推进只认服务端 created_at、且只前进不后退（CursorStore.advanceTo 已做单调保护）。
 */
@Singleton
class SyncCoordinator @Inject constructor(
    private val remote: SupabaseData,
    private val cache: MessageCacheDao,
    private val cursor: CursorStore,
    private val settings: SettingsStore,
    private val notifier: Notifier,
    private val diagnostics: Diagnostics,
) {
    // 同一时刻只允许一个补发在跑：并发补发会把游标推乱。
    private val syncMutex = Mutex()

    /**
     * 收到推送信封：只补这一条（按 id 取），比整批补发省得多。
     * 服务端可能还没把正文写完 → 取不到就退回一次小范围补发（下次兜底会再兜）。
     */
    suspend fun onPushed(event: RealtimeEvent.NewMessage) = withContext(Dispatchers.IO) {
        // 已通知过的高水位：重启后不把老消息再弹一遍。
        val lastNotified = runCatching { firstValue(settings.lastNotifiedMessageId) }.getOrNull()
        if (lastNotified == event.messageId) return@withContext

        val row = runCatching {
            remote.selectArr(
                table = "messages",
                columns = "id,session_id,role,character_id,content,origin,partial,created_at,read_at",
                filters = listOf("id=eq.${event.messageId}"),
                limit = 1,
            ).firstOrNull()
        }.getOrNull()

        if (row == null) {
            // 正文尚未就绪：退化为按游标补发（游标是权威的，不会漏）。
            backfill()
            return@withContext
        }

        val cached = row.toCachedFor(event.sessionId)
        // IGNORE 语义：id 已存在则不覆盖（避免把用户正在看的气泡换掉）。
        cache.backfillAndPrune(listOf(cached), AppConfig.Cache.MESSAGES_PER_SESSION)
        event.serverTimestampMs?.let { ms ->
            cursor.advanceTo(Timestamps.formatIsoUtc(ms))
        }
        deliverNotification(cached)
    }

    /**
     * 按 `last_seen_at` 补发（§5.1 第 2 层）。回前台、兜底 Worker、重连成功后都调它。
     *
     * 首次运行没有游标 → 从 3 天前起（Timestamps.sinceFallback），避免把全量历史当新消息弹。
     */
    suspend fun backfill(): Int = syncMutex.withLock {
        withContext(Dispatchers.IO) {
            val since = runCatching { cursor.lastSeenAtOnce() }.getOrNull()
                ?: Timestamps.sinceFallback()
            val rows = runCatching { remote.messagesSince(since) }.getOrElse { e ->
                diagnostics.debug("sync", "backfill failed ${e.javaClass.simpleName}")
                return@withContext 0
            }
            if (rows.isEmpty()) return@withContext 0

            val cached = rows.map { it.toCachedFor(it.strOf("session_id")) }
            cache.backfillAndPrune(cached, AppConfig.Cache.MESSAGES_PER_SESSION)

            // 只推进到本批最后一条：游标单调前进，漏消息与重通知之间的平衡点。
            cursor.advanceToLatest(rows.mapNotNull { it["created_at"]?.let { c -> c.toString().trim('"') } })

            // 只对 assistant 且未读的弹通知（Notifier 内部还有静音/渠道判断）。
            cached.forEach { deliverNotification(it) }
            diagnostics.debug("sync", "backfilled ${rows.size}")
            rows.size
        }
    }

    private suspend fun deliverNotification(msg: com.echosoul.app.data.local.CachedMessage) {
        if (msg.role != "assistant" || msg.readAt != null) return
        notifier.rememberForMerge(msg)
        notifier.notifyIfNeeded(msg)
        runCatching { settings.noteMessageNotified(msg.id) }
    }

    private fun JsonObject.toCachedFor(sessionId: String): com.echosoul.app.data.local.CachedMessage =
        com.echosoul.app.data.local.CachedMessage(
            id = strOf("id"),
            sessionId = sessionId.ifBlank { strOf("session_id") },
            role = strOf("role").ifBlank { "assistant" },
            characterId = get("character_id")?.let { if (it.toString() == "null") null else it.toString().trim('"') },
            content = HtmlSafe.plain(strOf("content")),
            origin = strOf("origin").ifBlank { "client" },
            partial = strOf("partial").equals("true", ignoreCase = true),
            createdAt = strOf("created_at"),
            readAt = get("read_at")?.let { if (it.toString() == "null") null else it.toString().trim('"') },
            cachedAt = System.currentTimeMillis(),
        )

    private fun JsonObject.strOf(key: String): String =
        get(key)?.toString()?.trim('"')?.takeIf { it != "null" } ?: ""

    private suspend fun <T> firstValue(flow: kotlinx.coroutines.flow.Flow<T>): T =
        kotlinx.coroutines.flow.first(flow)
}

/** 小工具：给 Flow<T> 取首个值（DataStore 用）。 */
private suspend fun <T> kotlinx.coroutines.flow.first(flow: kotlinx.coroutines.flow.Flow<T>): T =
   