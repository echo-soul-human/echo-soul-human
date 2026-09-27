package com.echosoul.app.realtime

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.echosoul.app.R
import com.echosoul.app.app.AppConfig
import com.echosoul.app.app.MainActivity
import com.echosoul.app.diagnostic.Diagnostics
import com.echosoul.app.notif.Notifier
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch

/**
 * 长连接宿主前台服务（§5.2）。
 *
 * ★ 与 manifest 对齐：`android:name=".realtime.RealtimeService"`、`foregroundServiceType="remoteMessaging"`。
 *   类型选错或漏写，Android 14+ 的 startForeground() 直接抛异常 —— 所以这里
 *   startForeground 必须带 [ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING]。
 *
 * ★ 三条底线（§5.2/§5.3）：
 *   1. **不做守护进程/互相唤醒/开机自启**：只用 START_STICKY 让系统在内存压力后重建。
 *   2. **常驻通知可关**：设置页关掉后本服务直接 stopSelf，绝不留一条无法关闭的通知。
 *   3. onStartCommand 必须 5s 内 startForeground，否则 ANR。
 */
@AndroidEntryPoint
class RealtimeService : Service() {

    @Inject lateinit var client: RealtimeClient
    @Inject lateinit var sync: SyncCoordinator
    @Inject lateinit var notifier: Notifier
    @Inject lateinit var diagnostics: Diagnostics
    @Inject lateinit var settings: com.echosoul.app.data.local.SettingsStore

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var stateJob: Job? = null
    private var eventJob: Job? = null

    override fun onCreate() {
        super.onCreate()
        notifier.ensureChannels()
        // 事件订阅只建一次：重连不该重复订阅。
        eventJob = client.events
            .onEach { event ->
                if (event is RealtimeEvent.NewMessage) {
                    scope.launch { sync.onPushed(event) }
                }
            }
            .launchIn(scope)
        stateJob = client.state
            .onEach { state -> updateNotification(state) }
            .launchIn(scope)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // ★ 必须最先执行：晚于 5s 就会 ANR 被杀。
        promoteToForeground(ConnectionState.Connecting(0))
        client.start()
        // START_STICKY：进程被系统回收后重建服务（注意不会重放 intent）。
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        client.stop()
        scope.cancel()
        super.onDestroy()
    }

    /**
     * 拉起前台。Android 14+ 必须显式传类型；低版本传 0 即可。
     * 通知渠道 IMPORTANCE_MIN + 独立渠道，用户可在设置里关（关掉会 stopSelf，见 [stopFromUser]）。
     */
    private fun promoteToForeground(state: ConnectionState) {
        val notification = buildNotification(state)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIF_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING,
            )
        } else {
            startForeground(NOTIF_ID, notification)
        }
    }

    private fun updateNotification(state: ConnectionState) {
        val nm = NotificationManagerCompat.from(this)
        if (!nm.areNotificationsEnabled()) return
        runCatching { nm.notify(NOTIF_ID, buildNotification(state)) }
            .onFailure { e -> diagnostics.debug("rt", "notify failed ${e.javaClass.simpleName}") }
    }

    private fun buildNotification(state: ConnectionState): android.app.Notification {
        val text = when (state) {
            is ConnectionState.Connected, is ConnectionState.Heartbeat ->
                getString(R.string.notif_service_text)
            is ConnectionState.Connecting, is ConnectionState.Disconnected ->
                getString(R.string.notif_service_text_paused)
            ConnectionState.Stopped -> getString(R.string.notif_service_text_paused)
        }
        val contentPending = android.app.PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHAN_SERVICE)
            .setSmallIcon(R.drawable.ic_stat_message)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setOngoing(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(contentPending)
            .build()
    }

    companion object {
        const val NOTIF_ID = 41001
        const val ACTION_START = "com.echosoul.app.action.RT_START"
        const val ACTION_STOP = "com.echosoul.app.action.RT_STOP"

        /**
         * 与 Notifier 里 createNotificationChannel(CHAN_SERVICE) 用的是同一个渠道 id。
         * 渠道由 Notifier.ensureChannels() 建；这里只引用 id，不能各写一个（那样通知会静默失败）。
         */
        const val CHAN_SERVICE = "chan_service"

        /** 用户开启"保持后台活跃"时调用。Android 12+ 后台启动前台服务有限制，故由前台 UI 触发。 */
        fun start(context: Context) {
            val i = Intent(context, RealtimeService::class.java).setAction(ACTION_START)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(i)
            } else {
                context.startService(i)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, RealtimeService::class.java))
        }

        /** 服务最长存活时间不设限，但完全依赖 START_STICKY 由系统决定是否重建。 */
        val heartbeatMs: Long get() = AppConfig.Realtime.HEARTBEAT_MS
    }
}
