package com.echosoul.app.notif

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.echosoul.app.data.remote.HttpEngine
import com.echosoul.app.data.remote.boolMap
import com.echosoul.app.data.remote.boolOr
import com.echosoul.app.data.remote.SupabaseData
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/**
 * Notifier 依赖的通知偏好读取口（Notifier 构造函数注入的就是它）。
 *
 * 为什么单独一层而不是直接读 SettingsStore：
 *   - Notifier 是**同步**调用（onMessage 回调里要立刻决定弹不弹），DataStore 是挂起读。
 *     所以这里在内存里保留一份"最近一次同步过的快照"，由 UI/服务在启动与改设置时刷新；
 *     Notifier 只读这个快照，不阻塞。
 *   - 角色名映射（通知标题要用）也在同一份快照里，来自角色列表最近一次拉取。
 *
 * ★ 快照默认值：careEnabled=true（主动关怀默认开，可在设置关）、vibrate=true。
 *   默认开是产品定案；用户关掉后落 DataStore + 同步服务端 notify_prefs（跨端一致）。
 */
@Singleton
class NotifyPrefs @Inject constructor(
    @ApplicationContext private val context: Context,
    private val remote: SupabaseData,
    private val http: HttpEngine,
) {
    @Volatile private var careEnabledCache: Boolean = true
    @Volatile private var hideContentCache: Boolean = false
    @Volatile private var vibrateCache: Boolean = true
    @Volatile private var mutedCache: Set<String> = emptySet()
    @Volatile private var namesCache: Map<String, String> = emptyMap()

    val careEnabled: Boolean get() = careEnabledCache
    val hideContent: Boolean get() = hideContentCache
    val vibrate: Boolean get() = vibrateCache

    fun isMuted(characterId: String): Boolean = characterId in mutedCache

    /** 通知标题要用的角色名；查不到时 Notifier 会回退成"TA"。 */
    fun nameOf(characterId: String): String? = namesCache[characterId]

    /** UI/服务启动时调一次：把持久化偏好灌进内存快照（不阻塞 Notifier）。 */
    suspend fun warmUp() {
        val prefs = context.notifyStore.data.first()
        careEnabledCache = prefs[K_CARE] ?: true
        hideContentCache = prefs[K_HIDE] ?: false
        vibrateCache = prefs[K_VIBRATE] ?: true
        mutedCache = prefs[K_MUTED]?.split(',')?.filter { it.isNotBlank() }?.toSet() ?: emptySet()
        // 服务端 notify_prefs 有则覆盖（跨端一致，验收 §15）。
        val uid = runCatching { http.userIdOrEmpty() }.getOrDefault("")
        if (uid.isNotEmpty()) {
            runCatching { remote.notifyPrefs() }.getOrNull()?.let { row ->
                careEnabledCache = row.boolOr("care_enabled", careEnabledCache)
                hideContentCache = row.boolOr("hide_content", hideContentCache)
                mutedCache = row.boolMap("per_character").filterValues { it }.keys
            }
        }
    }

    /** 设置页改开关时调用：立即更新内存快照 + 落 DataStore。 */
    suspend fun setCareEnabled(v: Boolean) {
        careEnabledCache = v
        context.notifyStore.edit { it[K_CARE] = v }
    }

    suspend fun setHideContent(v: Boolean) {
        hideContentCache = v
        context.notifyStore.edit { it[K_HIDE] = v }
    }

    suspend fun setVibrate(v: Boolean) {
        vibrateCache = v
        context.notifyStore.edit { it[K_VIBRATE] = v }
    }

    suspend fun setMuted(characterId: String, muted: Boolean) {
        mutedCache = if (muted) mutedCache + characterId else mutedCache - characterId
        context.notifyStore.edit { it[K_MUTED] = mutedCache.joinToString(",") }
    }

    /** 角色列表拉回来后灌一次，供通知标题用。 */
    fun updateNames(map: Map<String, String>) {
        namesCache = map
    }

    private companion object {
        val K_CARE = booleanPreferencesKey("notify_care")
        val K_HIDE = booleanPreferencesKey("notify_hide")
        val K_VIBRATE = booleanPreferencesKey("notify_vibrate")
        val K_MUTED = stringPreferencesKey("notify_muted")
    }
}

/** 通知偏好专用的 DataStore：与 SettingsStore 分开命名，避免两个委托指向同一文件。 */
private val Context.notifyStore: DataStore<Preferences> by preferencesDataStore(name = "echosoul_notify")
