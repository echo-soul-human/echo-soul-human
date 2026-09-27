package com.echosoul.app.ui.settings

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.echosoul.app.app.AppConfig
import com.echosoul.app.data.model.AndroidVersion
import com.echosoul.app.data.repo.AuthRepository
import com.echosoul.app.data.repo.SettingsRepository
import com.echosoul.app.diagnostic.Diagnostics
import com.echosoul.app.notif.Notifier
import com.echosoul.app.notif.NotifyPrefs
import com.echosoul.app.realtime.RealtimeService
import com.echosoul.app.realtime.SyncCoordinator
import com.echosoul.app.update.UpdateManager
import com.echosoul.app.update.UpdateUiState
import com.echosoul.app.update.VersionRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import android.content.Context
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * 设置页 VM。把"本机开关 + 跨端偏好 + 更新 + 诊断 + 登出"收在一处。
 *
 * ★ 权限时机（§13）：
 *   - "保持后台活跃"开关 → 打开时启动 RealtimeService（会用到 POST_NOTIFICATIONS，
 *     但那是服务通知；用户主动开这个开关是有意识的选择，不算"启动就弹"）。
 *   - 通知权限本身在**首次完成对话后**由 ChatScreen 申请，这里不重复弹。
 *   - 安装权限在点"立即更新"时由 UpdateManager 引导。
 */
@HiltViewModel
class SettingsViewModel @Inject constructor(
    private val settings: SettingsRepository,
    private val auth: AuthRepository,
    private val notifyPrefs: NotifyPrefs,
    private val notifier: Notifier,
    private val version: VersionRepository,
    private val updateManager: UpdateManager,
    private val sync: SyncCoordinator,
    private val diagnostics: Diagnostics,
    @ApplicationContext private val appContext: Context,
) : ViewModel() {

    val persistentConnection: StateFlow<Boolean> = settings.persistentConnection
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), true)
    val reduceMotion: StateFlow<Boolean> = settings.reduceMotion
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), false)
    val careVibrate: StateFlow<Boolean> = settings.careVibrate
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), true)
    val muted: StateFlow<Set<String>> = settings.mutedCharacters
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptySet())

    val updateState: StateFlow<UpdateUiState> = updateManager.state

    private val _available = MutableStateFlow<AndroidVersion?>(null)
    val available: StateFlow<AndroidVersion?> = _available.asStateFlow()

    private val _checking = MutableStateFlow(false)
    val checking: StateFlow<Boolean> = _checking.asStateFlow()

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message.asStateFlow()

    val versionLabel: String get() = "${AppConfig.versionName}（${AppConfig.versionCode}）"

    init {
        viewModelScope.launch { notifyPrefs.warmUp() }
    }

    // ─── 本机开关 ───
    fun setPersistentConnection(v: Boolean) {
        viewModelScope.launch {
            settings.setPersistentConnection(v)
            if (v) {
                notifier.ensureChannels()
                RealtimeService.start(appContext)
            } else {
                // ★ 关掉就真的停：绝不留一条关不掉的常驻通知（§5.2）。
                RealtimeService.stop(appContext)
            }
        }
    }

    fun setReduceMotion(v: Boolean) {
        viewModelScope.launch { settings.setReduceMotion(v) }
    }

    fun setCareVibrate(v: Boolean) {
        viewModelScope.launch {
            notifyPrefs.setVibrate(v)
            settings.setCareVibrate(v)
        }
    }

    /** 角色级静音：本地 + 服务端（跨端一致）。 */
    fun setMuted(characterId: String, muted: Boolean) {
        viewModelScope.launch { settings.setMuted(characterId, muted) }
    }

    // ─── 更新 ───
    fun checkUpdate() {
        if (_checking.value) return
        _checking.value = true
        viewModelScope.launch {
            val v = version.fetch()
            _checking.value = false
            if (v == null) {
                _message.value = "没检查到版本信息，网络稳一点再试。"
            } else if (version.needsUpdate(v)) {
                _available.value = v
            } else {
                _message.value = "已经是最新版了。"
            }
        }
    }

    /**
     * 立即更新：先看有没有取消过的包 → 有就直接校验安装，没有才发起下载。
     * 安装权限在这里（用户点了更新）引导，不在启动时。
     */
    fun startUpdate(v: AndroidVersion) {
        viewModelScope.launch {
            if (version.verifyPendingIfAny(v)) {
                _message.value = "上次下到一半的包还在，直接校验安装就好。"
                return@launch
            }
            val id = updateManager.enqueue(v)
            if (id < 0) {
                _message.value = "下载没能开始，改用浏览器试试。"
            } else {
                settings.setPendingApkId(id)
            }
        }
    }

    fun cancelUpdate(downloadId: Long) {
        updateManager.cancel(downloadId)
        _message.value = "已暂停下载。"
    }

    fun openInstallPermission() = updateManager.openInstallPermissionSettings()

    fun snoozeUpdate(v: AndroidVersion) {
        viewModelScope.launch {
            settings.snoozeUpdate(v.versionCode)
            _available.value = null
        }
    }

    fun openBrowserDownload(v: AndroidVersion) {
        runCatching {
            appContext.startActivity(
                Intent(Intent.ACTION_VIEW, Uri.parse(v.url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }
    }

    // ─── ROM 白名单引导（§5.3）───
    /** 各 ROM 的后台设置页入口；失败回落通用应用详情页。 */
    fun openRomSettings() {
        val intents = buildList {
            add(Intent().setClassName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"))
            add(Intent().setClassName("com.coloros.safecenter", "com.coloros.safefinder.action.PermissionActivity"))
            add(Intent().setClassName("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"))
            add(Intent().setClassName("com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity"))
            add(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${appContext.packageName}")))
        }
        for (i in intents) {
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (runCatching { appContext.startActivity(i) }.isSuccess) return
        }
    }

    fun markRomGuideShown() {
        viewModelScope.launch { settings.markRomGuideShown() }
    }

    fun dismissRomGuideForever() {
        viewModelScope.launch { settings.dismissRomGuideForever() }
    }

    // ─── 诊断（不静默上传）───
    fun diagnosticsText(): String = diagnostics.dump()

    // ─── 账号 ───
    fun signOut(onDone: () -> Unit) {
        viewModelScope.launch {
            auth.signOut()
            onDone()
        }
    }

    fun flushSync() {
        viewModelScope.launch { sync.backfill() }
    }

    fun consumeMessage() { _message.value = null }

    fun clearAvailable() { _available.value = null }

    /** 当前是否 Android 13+（用于决定是否显示"通知权限"相关引导）。 */
    val needsNotificationPermission: Boolean
        get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !notifier.canPost()
}
