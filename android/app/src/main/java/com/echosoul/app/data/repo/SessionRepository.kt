package com.echosoul.app.data.repo

import com.echosoul.app.data.local.SessionIndexDao
import com.echosoul.app.data.local.SessionIndexEntity
import com.echosoul.app.data.local.SessionRow
import com.echosoul.app.data.local.toRow
import com.echosoul.app.data.remote.SupabaseData
import com.echosoul.app.diagnostic.Diagnostics
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

/**
 * 会话列表 Repository。
 *
 * 读路径永远是 **先看本地缓存**（`session_index`，冷启动立即有东西画），
 * 网络刷新是"顺带做"的背景动作：打开即刷，失败静默（下次进还会再试）。
 *
 * ★ 这里不排序、不算未读、不拼预览 —— 那些全在 list_sessions() 里做好（架构 §7.1）。
 *   客户端只把服务端返回的整表覆盖进本地，不叠加自己的判断。
 */
@Singleton
class SessionRepository @Inject constructor(
    private val remote: SupabaseData,
    private val indexDao: SessionIndexDao,
    private val diagnostics: Diagnostics,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** UI 只看这一条：本地缓存 → 展示行。真源是服务端，本地只是"上次看到的"。 */
    val sessions: Flow<List<SessionRow>> =
        indexDao.observeAll().map { list -> list.map { it.toRow() } }

    /** 打开列表时调用；不阻塞、不抛异常 —— 没网就继续用缓存。 */
    fun refreshInBackground() {
        scope.launch { refresh() }
    }

    suspend fun refresh(): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            val rows = remote.listSessions()
            indexDao.replaceAll(rows.map { it.toIndexEntity() })
            true
        }.getOrElse { e ->
            // 静默失败：列表页用缓存继续显示。诊断里留一条，方便排"为什么列表不更新"。
            diagnostics.debug("session", "refresh failed ${e.javaClass.simpleName}")
            false
        }
    }

    suspend fun openSession(characterId: String): String? = withContext(Dispatchers.IO) {
        runCatching { remote.openSession(characterId) }.getOrNull()
    }

    suspend fun createGroup(characterIds: List<String>, title: String?): String? =
        withContext(Dispatchers.IO) {
            runCatching { remote.createGroup(characterIds, title) }.getOrNull()
        }

    private fun JsonObject.toIndexEntity(): SessionIndexEntity {
        val cols = toSessionIndexColumns()
        return SessionIndexEntity(
            id = cols.id,
            kind = cols.kind,
            title = cols.title,
            // 逗号串是本地存储形态：群成员上限 ≤8，不值得为它写 TypeConverter。
            characterIds = cols.characterIds.joinToString(","),
            characterNames = cols.characterNames.joinToString(","),
            preview = cols.preview,
            unread = cols.unread,
            lastMsgAt = cols.lastMsgAt,
        )
    }
}
