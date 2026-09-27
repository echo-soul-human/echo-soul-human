package com.echosoul.app.data.local

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/** 单例 DataStore 实例：preferencesDataStore 的委托必须只在一处，多处会各建一个文件。 */
private val Context.cursorStore: DataStore<Preferences> by preferencesDataStore(name = "echosoul_cursor")
private val Context.settingsStore: DataStore<Preferences> by preferencesDataStore(name = "echosoul_settings")

/**
 * 补发游标（分册 §10）。
 *
 * 长连接断开期间到达的消息以数据库为真源，回前台时按 `GET /messages?since=<last_seen_at>`
 * 补发 —— 所以这个值**只能前进不能后退**：后退会让用户重复收到同一批通知，
 * 前进过头则会漏消息。[set] 里做了单调保护。
 *
 * 存的是服务端 messages.created_at 原样字符串（timestamptz），不做本地格式转换：
 * 转成 Date 再转回去会因为时区把游标挪几小时，那正是"边界上丢一条"的成因。
 */
@Singleton
class CursorStore @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    fun lastSeenAt(): Flow<String?> = context.cursorStore.data.map { it[K_LAST_SEEN] }

    suspend fun lastSeenAtOnce(): String? = context.cursorStore.data.map { it[K_LAST_SEEN] }.first()

    /**
     * 单调推进（只能前进不能后退）。
     *
     * ★ 不用字符串字典序比较：messages.created_at 经 JSON 传来时小数位数可变
     *   （`2026-09-27 16:29:04.512345+08` 与 `2026-09-27 16:29:04+08`），直接比字符串
     *   会在"同秒不同位数"上给出错结果 —— 那正是边界上丢一条/重一条的成因。
     *   所以先解析成 epoch 毫秒再比；存回去仍存服务端原串，补发查询用的就是它
     *   （不做本地格式往返，避免时区把游标挪几小时）。
     */
    suspend fun advanceTo(value: String) {
        val parsed = Timestamps.parseMillis(value) ?: return
        context.cursorStore.edit { prefs ->
            val currentParsed = prefs[K_LAST_SEEN]?.let { Timestamps.parseMillis(it) }
            if (currentParsed == null || parsed > currentParsed) prefs[K_LAST_SEEN] = value
        }
    }

    /** 把补发结果的最后一条 created_at 记为游标（内部仍走单调保护）。 */
    suspend fun advanceToLatest(values: List<String>) {
        var best: String? = null
        var bestMs = Long.MIN_VALUE
        for (v in values) {
            val ms = Timestamps.parseMillis(v) ?: continue
            if (ms > bestMs) { bestMs = ms; best = v }
        }
        best?.let { advanceTo(it) }
    }

    /** 注销/换账号时必须清，否则新账号会拿旧账号的时间点去补发。 */
    suspend fun reset() {
        context.cursorStore.edit { it.clear() }
    }

    private companion object {
        val K_LAST_SEEN = stringPreferencesKey("last_seen_at")
    }
}

/**
 * 客户端偏好。只放"显示与输入"相关的开关；业务规则一律在服务端。
 * ROM 引导是否弹过、永久关闭标记也在这里 —— 它决定的是本机行为，不是权益。
 */
@Singleton
class SettingsStore @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    /** 常驻通知（降低后台活跃）开关。默认开 + 明确说明 + 可关（§5.2 / A2 倾向）。 */
    val persistentConnection: Flow<Boolean> = context.settingsStore.data
        .map { it[K_PERSISTENT] ?: true }

    /** 锁屏隐藏通知内容。 */
    val hideNotificationContent: Flow<Boolean> = context.settingsStore.data
        .map { it[K_HIDE_CONTENT] ?: false }

    val careVibrate: Flow<Boolean> = context.settingsStore.data
        .map { it[K_VIBRATE] ?: true }

    /** 减弱动效：跟随系统 AnimatorDurationScale==0，也可手动开。低端机由 Perf 自动叠加。 */
    val reduceMotion: Flow<Boolean> = context.settingsStore.data
        .map { it[K_REDUCE_MOTION] ?: false }

    /** 首次完成对话后才弹一次；一旦弹过或用户点了「不再提示」就永不再弹。 */
    val romGuideShown: Flow<Boolean> = context.settingsStore.data
        .map { it[K_ROM_SHOWN] ?: false }

    val romGuideDismissedForever: Flow<Boolean> = context.settingsStore.data
        .map { it[K_ROM_NEVER] ?: false }

    /** 已通知过的消息 id 高水位，避免重启后把老消息又弹一遍。 */
    val lastNotifiedMessageId: Flow<String?> = context.settingsStore.data
        .map { it[K_LAST_NOTIFIED_ID] }

    suspend fun setPersistentConnection(v: Boolean) = context.settingsStore.edit { it[K_PERSISTENT] = v }
    suspend fun setHideNotificationContent(v: Boolean) = context.settingsStore.edit { it[K_HIDE_CONTENT] = v }
    suspend fun setCareVibrate(v: Boolean) = context.settingsStore.edit { it[K_VIBRATE] = v }
    suspend fun setReduceMotion(v: Boolean) = context.settingsStore.edit { it[K_REDUCE_MOTION] = v }
    suspend fun markRomGuideShown() = context.settingsStore.edit { it[K_ROM_SHOWN] = true }
    suspend fun dismissRomGuideForever() = context.settingsStore.edit { it[K_ROM_NEVER] = true }
    suspend fun noteMessageNotified(id: String) = context.settingsStore.edit { it[K_LAST_NOTIFIED_ID] = id }

    /** 角色级静音存在本地一份 + notify_prefs 同步一份（多端一致，验收 §15）。 */
    val mutedCharacters: Flow<Set<String>> = context.settingsStore.data
        .map { rawListOf(it[K_MUTED]) }

    suspend fun setMuted(characterId: String, muted: Boolean) {
        context.settingsStore.edit { prefs ->
            val cur = rawListOf(prefs[K_MUTED]).toMutableSet()
            if (muted) cur += characterId else cur -= characterId
            prefs[K_MUTED] = cur.joinToString(",")
        }
    }

    private fun rawListOf(s: String?): Set<String> =
        s?.split(',')?.filter { it.isNotBlank() }?.toSet() ?: emptySet()

    private companion object {
        val K_PERSISTENT = booleanPreferencesKey("persistent_connection")
        val K_HIDE_CONTENT = booleanPreferencesKey("hide_notification_content")
        val K_VIBRATE = booleanPreferencesKey("care_vibrate")
        val K_REDUCE_MOTION = booleanPreferencesKey("reduce_motion")
        val K_ROM_SHOWN = booleanPreferencesKey("rom_guide_shown")
        val K_ROM_NEVER = booleanPreferencesKey("rom_guide_never")
        val K_LAST_NOTIFIED_ID = stringPreferencesKey("last_notified_message_id")
        val K_MUTED = stringPreferencesKey("muted_characters")
    }
}

/** 上次成功检查更新的时间，用来给自动检查限频（一天一次足够）。 */
@Singleton
class UpdateStore @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    val lastCheckAt: Flow<Long> = context.settingsStore.data.map { it[K_CHECK_AT] ?: 0L }

    suspend fun markChecked(nowMs: Long) = context.settingsStore.edit { it[K_CHECK_AT] = nowMs }

    /** 用户点「稍后」后记一次，避免每次都弹同一个版本的层。 */
    val snoozedVersionCode: Flow<Int> = context.settingsStore.data.map {
        (it[K_SNOOZE_CODE] ?: 0L).toInt()
    }

    suspend fun snooze(versionCode: Int) = context.settingsStore.edit { it[K_SNOOZE_CODE] = versionCode.toLong() }

    /** 下载被取消时保留包，下次直接校验安装不重下（§7）。 */
    val pendingApkId: Flow<Long> = context.settingsStore.data.map { it[K_APK_ID] ?: -1L }

    suspend fun setPendingApkId(downloadId: Long) = context.settingsStore.edit { it[K_APK_ID] = downloadId }

    suspend fun clearPendingApkId() = context.settingsStore.edit { it.remove(K_APK_ID) }

    private companion object {
        val K_CHECK_AT = longPreferencesKey("update_last_check_at")
        val K_SNOOZE_CODE = longPreferencesKey("update_snooze_code")
        val K_APK_ID = longPreferencesKey("update_pending_download_id")
    }
}
