package com.echosoul.app.svc

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.echosoul.app.R
import com.echosoul.app.diagnostic.Diagnostics
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

/**
 * TTS 播放的 MediaSession 宿主（manifest: `.svc.TtsPlaybackService`, mediaPlayback 类型）。
 *
 * 为什么单独一个前台服务而不是塞进 RealtimeService：前台服务类型一旦混用，
 * Android 14+ 会因为"声明类型与实际用途不符"在后台启动时抛异常。语音播放属于
 * mediaPlayback，和 remoteMessaging 是两类，必须各占一个。
 *
 * ★ 本期（P7 未开工）只落壳：真正的播放由 media3 ExoPlayer + MediaSession 接进来。
 *   留这个服务是为了让 manifest 引用的组件真实存在（否则安装后组件解析失败），
 *   并在无播放时立即 stopForeground/stopSelf，不做"挂着前台服务空转"的耗电行为。
 */
@AndroidEntryPoint
class TtsPlaybackService : Service() {

    @Inject lateinit var diagnostics: Diagnostics

    override fun onCreate() {
        super.onCreate()
        diagnostics.debug("tts", "playback service created")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 无实际播放任务 → 不 promote 到前台，直接结束，避免空转前台服务。
        if (intent?.action != ACTION_PLAY) {
            stopSelf(startId)
            return START_NOT_STICKY
        }
        // 有播放任务时才进前台（本期尚未接入真实播放，接口留好）。
        promote()
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun promote() {
        val n = NotificationCompat.Builder(this, CHAN_SERVICE)
            .setSmallIcon(R.drawable.ic_stat_message)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(getString(R.string.notif_service_text))
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIF_ID, n,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
            )
        } else {
            startForeground(NOTIF_ID, n)
        }
    }

    /** 播放结束：撤前台、撤通知、停服务。不做常驻。 */
    fun finishPlayback() {
        NotificationManagerCompat.from(this).cancel(NOTIF_ID)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    companion object {
        const val ACTION_PLAY = "com.echosoul.app.action.TTS_PLAY"
        const val NOTIF_ID = 42001
        const val CHAN_SERVICE = "chan_service" // 与 Notifier 建的低优先级渠道同源

        fun play(context: Context, text: String, characterId: String?) {
            val i = Intent(context, TtsPlaybackService::class.java)
                .setAction(ACTION_PLAY)
                .putExtra(EXTRA_TEXT, text)
                .putExtra(EXTRA_CHARACTER, characterId)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(i)
            } else {
                context.startService(i)
            }
        }

        const val EXTRA_TEXT = "text"
        const val EXTRA_CHARACTER = "character_id"
    }
}
