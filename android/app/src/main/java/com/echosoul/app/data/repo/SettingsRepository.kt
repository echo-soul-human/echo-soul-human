package com.echosoul.app.data.repo

import com.echosoul.app.data.local.SettingsStore
import com.echosoul.app.data.local.UpdateStore
import com.echosoul.app.data.model.NotifyPrefsRow
import com.echosoul.app.data.remote.HttpEngine
import com.echosoul.app.data.remote.SupabaseData
import com.echosoul.app.diagnostic.Diagnostics
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

/**
 * 设置 Repository。把"本机偏好"（DataStore）与"跨端同步偏好"（notify_prefs 表）合到一处。
 *
 * ★ 边界（验收 §15）：
 *   - care_enabled / per_character / hide_content 是**跨端**的 → 落服务端 notify_prefs，
 *     任一端改了，另一端可见。
 *   - reduce_motion / rom_guide / 常驻连接开关是**本机**行为 → 只落 DataStore，
 *     不该同步到账号上（换机后动效偏好跟随的是新机性能，不是账号）。
 */
@Singleton
class SettingsRepository @Inject constructor(
    private val local: SettingsStore,
    private val updateStore: UpdateStore,
    private val remote: SupabaseData,
    private val http: HttpEngine,
    private val diagnostics: Diagnostics,
) {
    // ─── 本机偏好（DataStore 直通）───
    val persistentConnection: Flow<Boolean> = local.persistentConnection
    val reduceMotion: Flow<Boolean> = local.reduceMotion
    val careVibrate: Flow<Boolean> = local.careVibrate
    val romGuideShown: Flow<Boolean> = local.romGuideShown
    val romGuideDismissedForever: Flow<Boolean> = local.romGuideDismissedForever
    val mutedCharacters: Flow<Set<String>> = local.mutedCharacters
    val lastNotifiedMessageId: Flow<String?> = local.lastNotifiedMessageId

    suspend fun setPersistentConnection(v: Boolean) = local.setPersistentConnection(v)
    suspend fun setReduceMotion(v: Boolean) = local.setReduceMotion(v)
    suspend fun setCareVibrate(v: Boolean) = local.setCareVibrate(v)
    suspend fun markRomGuideShown() = local.markRomGuideShown()
    suspend fun dismissRomGuideForever() = local.dismissRomGuideForever()
    suspend fun noteMessageNotified(id: String) = local.noteMessageNotified(id)

    /**
     * 角色级静音：本地立即生效 + 同步服务端（多端一致）。
     * 本地先落是为了"点了立刻有感"，服务端失败不回滚 —— 下次同步会以服务端为准覆盖。
     */
    suspend fun setMuted(characterId: String, muted: Boolean) = withContext(Dispatchers.IO) {
        local.setMuted(characterId, muted)
        runCatching {
            val uid = remoteUserId()
            if (uid.isEmpty()) return@runCatching
            val current = remote.notifyPrefs()?.let { it.toNotifyPrefsRow(uid).perCharacter } ?: emptyMap()
            val next = if (muted) current + (characterId to true) else current - characterId
            remote.saveNotifyPrefs(careEnabled = null, perCharacter = next, hideContent = null)
        }.onFailure { e -> diagnostics.debug("settings", "mute sync failed ${e.javaClass.simpleName}") }
    }

    // ─── 跨端偏好（notify_prefs）───
    suspend fun loadRemotePrefs(): NotifyPrefsRow? = withContext(Dispatchers.IO) {
        val uid = remoteUserId()
        if (uid.isEmpty()) return@withContext null
        runCatching { remote.notifyPrefs()?.toNotifyPrefsRow(uid) }.getOrNull()
    }

    suspend fun saveRemotePrefs(careEnabled: Boolean?, perCharacter: Map<String, Boolean>?, hideContent: Boolean?) =
        withContext(Dispatchers.IO) {
            runCatching { remote.saveNotifyPrefs(careEnabled, perCharacter, hideContent) }
                .onFailure { e -> diagnostics.debug("settings", "prefs save failed ${e.javaClass.simpleName}") }
        }

    // ─── 更新检查限频 ───
    val lastUpdateCheckAt: Flow<Long> = updateStore.lastCheckAt
    suspend fun markUpdateChecked(nowMs: Long) = updateStore.markChecked(nowMs)
    val snoozedVersionCode: Flow<Int> = updateStore.snoozedVersionCode
    suspend fun snoozeUpdate(versionCode: Int) = updateStore.snooze(versionCode)
    val pendingApkId: Flow<Long> = updateStore.pendingApkId
    suspend fun setPendingApkId(downloadId: Long) = updateStore.setPendingApkId(downloadId)
    suspend fun clearPendingApkId() = updateStore.clearPendingApkId()

    private fun remoteUserId(): String = http.userIdOrEmpty()
}

/** 便于在 UI 层直接序列化 notify_prefs 的 per_character。 */
fun NotifyPrefsRow.toJsonObject(): JsonObject = JsonObject(
    buildMap {
        put("care_enabled", kotlinx.serialization.json.JsonPrimitive(careEnabled))
        put("hide_content", kotlinx.serialization.json.JsonPrimitive(hideContent))
        put(
            "per_character",
            JsonObject(perCharacter.mapValues { kotlinx.serialization.json.JsonPrimitive(it.value) }),
        )
    },
)
