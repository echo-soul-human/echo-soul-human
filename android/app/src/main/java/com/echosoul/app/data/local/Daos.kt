package com.echosoul.app.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

@Dao
interface MessageCacheDao {
    @Query("SELECT * FROM cached_messages WHERE session_id = :sessionId ORDER BY created_at ASC")
    fun observeSession(sessionId: String): Flow<List<CachedMessage>>

    @Query(
        "SELECT * FROM cached_messages WHERE session_id = :sessionId " +
            "ORDER BY created_at DESC LIMIT :limit",
    )
    suspend fun latest(sessionId: String, limit: Int): List<CachedMessage>

    @Query("SELECT COUNT(*) FROM cached_messages WHERE session_id = :sessionId")
    suspend fun count(sessionId: String): Int

    /** 服务端落库版本覆盖本地流式拼接结果（拿到 usage 之后必须走这一条）。 */
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(rows: List<CachedMessage>)

    /** 补发用 IGNORE：已显示过的 id 不覆盖，免得把用户正在看的那条换掉。 */
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertIgnore(rows: List<CachedMessage>): List<Long>

    @Query("UPDATE cached_messages SET read_at = :readAt WHERE session_id = :sessionId AND read_at IS NULL")
    suspend fun markAllRead(sessionId: String, readAt: String)

    @Query("DELETE FROM cached_messages WHERE session_id = :sessionId")
    suspend fun clearSession(sessionId: String)

    /**
     * LRU 裁剪：每会话只留最近 :keep 条（按本地写入时刻 cached_at）。
     * 与写入放同一事务，见 [cacheAndPrune] —— 低端机上这条不能散在插入路径外跑。
     */
    @Query(
        "DELETE FROM cached_messages WHERE session_id = :sessionId AND id NOT IN (" +
            "SELECT id FROM cached_messages WHERE session_id = :sessionId " +
            "ORDER BY cached_at DESC LIMIT :keep)",
    )
    suspend fun pruneSession(sessionId: String, keep: Int)

    @Transaction
    suspend fun cacheAndPrune(rows: List<CachedMessage>, keep: Int) {
        if (rows.isEmpty()) return
        upsertAll(rows)
        rows.map { it.sessionId }.distinct().forEach { pruneSession(it, keep) }
    }

    @Transaction
    suspend fun backfillAndPrune(rows: List<CachedMessage>, keep: Int) {
        if (rows.isEmpty()) return
        insertIgnore(rows)
        rows.map { it.sessionId }.distinct().forEach { pruneSession(it, keep) }
    }
}

@Dao
interface DraftDao {
    @Query("SELECT text FROM drafts WHERE session_id = :sessionId")
    fun observeText(sessionId: String): Flow<String?>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun put(row: DraftRow)

    @Query("DELETE FROM drafts WHERE session_id = :sessionId")
    suspend fun clear(sessionId: String)
}

@Dao
interface OutboxDao {
    @Query("SELECT * FROM outbox WHERE state IN ('pending','failed') ORDER BY created_at ASC LIMIT :limit")
    suspend fun drainable(limit: Int): List<OutboxRow>

    @Query("SELECT COUNT(*) FROM outbox")
    fun observeCount(): Flow<Int>

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun enqueue(row: OutboxRow): Long

    @Update
    suspend fun update(row: OutboxRow)

    @Query("DELETE FROM outbox WHERE id = :id")
    suspend fun remove(id: String)

    @Query("UPDATE outbox SET state = :state, attempts = attempts + 1 WHERE id = :id")
    suspend fun bumpState(id: String, state: String)
}

@Dao
interface SessionIndexDao {
    @Query("SELECT * FROM session_index ORDER BY last_msg_at DESC")
    fun observeAll(): Flow<List<SessionIndexEntity>>

    @Query("DELETE FROM session_index")
    suspend fun clearAll()

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(rows: List<SessionIndexEntity>)

    @Query("SELECT character_ids FROM session_index WHERE id = :sessionId")
    suspend fun characterIdsOf(sessionId: String): String?

    /** list_sessions() 的返回是整表真源，所以先清后插，不做逐行 diff。 */
    @Transaction
    suspend fun replaceAll(rows: List<SessionIndexEntity>) {
        clearAll()
        upsertAll(rows)
    }
}

/** session_index 行的展示视图：逗号串还原成列表，UI 只看这个。 */
data class SessionRow(
    val id: String,
    val kind: String,
    val title: String?,
    val characterIds: List<String>,
    val characterNames: List<String>,
    val preview: String?,
    val unread: Int,
    val lastMsgAt: String?,
)

fun SessionIndexEntity.toRow(): SessionRow = SessionRow(
    id = id,
    kind = kind,
    title = title,
    characterIds = characterIds.split(',').filter { it.isNotBlank() },
    characterNames = characterNames.split(',').filter { it.isNotBlank() },
    preview = preview,
    unread = unread,
    lastMsgAt = lastMsgAt,
)
