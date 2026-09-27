package com.echosoul.app.data.local

import androidx.room.ColumnInfo
import androidx.room.Entity
// ★ 导入必须带别名：Kotlin 2.x 的 stdlib 里有 kotlin.collections.Index（排序结果的 public final class），
//   它在本文件作用域内会遮蔽 androidx.room.Index，导致 `@Index(...)` 报
//   "This annotation is not applicable to target 'class'"。
import androidx.room.Index as RoomIndex
import androidx.room.PrimaryKey

/**
 * 消息渲染缓存。★ **不是真源**（分册 §10）：真源永远是 Postgres 的 messages 表，
 * 这张表可以随时清空，代价只是"下次进会话多等一次网络"。
 */
@Entity(
    tableName = "cached_messages",
    indices = [
        RoomIndex(value = ["session_id", "created_at"], name = "idx_cache_session_time"),
    ],
)
data class CachedMessage(
    /**
     * 服务端 messages.id —— 同时是去重键与 LRU 时钟。
     *
     * ★ 为什么用 id 排序而不是时间戳：messages.id 是 `uuid primary key default gen_random_uuid()`
     *   （v4 随机 uuid），它**不单调**。所以插入顺序一律以 created_at 为准；
     *   id 只用来去重（补发与实时推送同时到达，见 §5.4）。
     *   这一点在 MigrationNotes 里也标了：将来若换成 uuidv7，这里的语义要一起重审。
     */
    @PrimaryKey val id: String,
    @ColumnInfo(name = "session_id") val sessionId: String,
    val role: String,
    @ColumnInfo(name = "character_id") val characterId: String? = null,
    val content: String = "",
    val origin: String = "client",
    val partial: Boolean = false,
    @ColumnInfo(name = "created_at") val createdAt: String = "",
    @ColumnInfo(name = "read_at") val readAt: String? = null,
    /** 本地写入时刻（epoch ms）。LRU 按它裁剪，不用 created_at —— 后者是服务端字符串格式。 */
    @ColumnInfo(name = "cached_at") val cachedAt: Long = System.currentTimeMillis(),
)

/** 草稿：防丢。切会话、进程被杀都还在。 */
@Entity(tableName = "drafts")
data class DraftRow(
    @PrimaryKey @ColumnInfo(name = "session_id") val sessionId: String,
    val text: String = "",
    @ColumnInfo(name = "updated_at") val updatedAt: Long = System.currentTimeMillis(),
)

/**
 * 离线待发队列（分册 §4「无网络」那一行）：用户消息先进本地队列，
 * 恢复后按**原幂等键**重发 —— 换键就是重复扣费。
 */
@Entity(
    tableName = "outbox",
    indices = [RoomIndex(value = ["state", "created_at"], name = "idx_outbox_ready")],
)
data class OutboxRow(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "session_id") val sessionId: String,
    val content: String,
    /** 幂等键在入队那一刻生成，之后所有重试复用它。 */
    @ColumnInfo(name = "idempotency_key") val idempotencyKey: String,
    @ColumnInfo(name = "provider_profile_id") val providerProfileId: String? = null,
    @ColumnInfo(name = "provider_kind") val providerKind: String? = null,
    val state: String = STATE_PENDING,
    val attempts: Int = 0,
    @ColumnInfo(name = "created_at") val createdAt: Long = System.currentTimeMillis(),
) {
    companion object {
        const val STATE_PENDING = "pending"
        const val STATE_SENDING = "sending"
        const val STATE_FAILED = "failed"
    }
}

/**
 * 会话索引缓存。列表页要在"刚打开、网络还没回来"时就有东西可画，
 * 所以这份必须落盘；但它的真源仍是 list_sessions()，每次整表覆盖。
 */
@Entity(tableName = "session_index")
data class SessionIndexEntity(
    @PrimaryKey val id: String,
    val kind: String = "solo",
    val title: String? = null,
    /** 逗号分隔而不是 TypeConverter：少一层一次性代码，群聊成员上限本来就 ≤8。 */
    @ColumnInfo(name = "character_ids") val characterIds: String = "",
    @ColumnInfo(name = "character_names") val characterNames: String = "",
    val preview: String? = null,
    val unread: Int = 0,
    @ColumnInfo(name = "last_msg_at") val lastMsgAt: String? = null,
)
