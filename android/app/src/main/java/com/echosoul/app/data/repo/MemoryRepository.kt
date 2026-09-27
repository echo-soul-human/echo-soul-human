package com.echosoul.app.data.repo

import com.echosoul.app.data.local.Timestamps
import com.echosoul.app.data.remote.HttpEngine
import com.echosoul.app.data.remote.SupabaseData
import com.echosoul.app.data.remote.boolOr
import com.echosoul.app.data.remote.str
import com.echosoul.app.diagnostic.Diagnostics
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * 记忆条目（长期记忆）Repository。
 *
 * 后端 005_memory.sql 里记忆是**向量 + 摘要**两段，客户端的记忆页只做两件事：
 *   1. 列出可读的记忆摘要（供用户查看/删除，满足"我的数据我能管"）；
 *   2. 删除某条记忆（RLS 保证只能删自己账号下的）。
 * 检索（top_k / 相似度）**不在客户端做**，由 chat 主链路在服务端完成（分册 §3）。
 */
@Singleton
class MemoryRepository @Inject constructor(
    private val remote: SupabaseData,
    private val http: HttpEngine,
    private val diagnostics: Diagnostics,
) {
    private val _memories = MutableStateFlow<List<MemoryItem>>(emptyList())
    val memories: StateFlow<List<MemoryItem>> = _memories.asStateFlow()

    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading.asStateFlow()

    suspend fun refresh(characterId: String? = null) = withContext(Dispatchers.IO) {
        val uid = http.userIdOrEmpty()
        // 未登录：RLS 会让查询返回空集，这里直接短路省一个来回。
        if (uid.isEmpty()) {
            _memories.value = emptyList()
            return@withContext
        }
        _loading.value = true
        val filters = buildList {
            add("user_id=eq.$uid")
            if (characterId != null) add("character_id=eq.$characterId")
            add("deleted_at=is.null")
        }
        runCatching {
            remote.selectArr(
                table = "memories",
                columns = "id,character_id,summary,importance,created_at,last_used_at,pinned",
                filters = filters,
                order = "created_at.desc",
                limit = 200,
            )
        }.onSuccess { rows -> _memories.value = rows.map { it.toMemoryItem() } }
            .onFailure { e -> diagnostics.debug("memory", "list failed ${e.javaClass.simpleName}") }
        _loading.value = false
    }

    suspend fun forget(id: String): Boolean = withContext(Dispatchers.IO) {
        // 软删：deleted_at 置位，服务端检索会排除它；硬删由账号注销走 erase 链路。
        val ok = runCatching {
            remote.patch(
                table = "memories",
                filter = "id=eq.$id",
                patch = JsonObject(
                    mapOf("deleted_at" to JsonPrimitive(Timestamps.formatIsoUtc(System.currentTimeMillis()))),
                ),
            )
        }.getOrDefault(false)
        if (ok) _memories.value = _memories.value.filterNot { it.id == id }
        ok
    }

    private fun JsonObject.toMemoryItem(): MemoryItem = MemoryItem(
        id = str("id").orEmpty(),
        characterId = str("character_id"),
        summary = str("summary").orEmpty(),
        importance = str("importance")?.toDoubleOrNull() ?: 0.0,
        createdAt = str("created_at").orEmpty(),
        lastUsedAt = str("last_used_at"),
        pinned = boolOr("pinned", false),
    )

    data class MemoryItem(
        val id: String,
        val characterId: String?,
        val summary: String,
        val importance: Double,
        val createdAt: String,
        val lastUsedAt: String?,
        val pinned: Boolean,
    )
}
