package com.echosoul.app.notif

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.echosoul.app.data.repo.MessageRepository
import com.echosoul.app.diagnostic.Diagnostics
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * 通知动作接收器（manifest: `.notif.NotificationActionReceiver`，exported=false）。
 *
 * 只处理本应用自己发出的 PendingIntent（不导出 → 外部无法伪造动作），两类：
 *   1. 点通知 → 打开对应会话（实际的 Activity 跳转由 Notifier 里那个 getActivity PendingIntent 做，
 *      走到这里的是"标记已读"这类副作用）；
 *   2. 「已读」动作 → 调 mark_read(session) 让服务端记录，另一端不再弹（验收 V5-33）。
 *
 * ★ 为什么"已读"要落服务端而不是只清本地：多端一致。网页看过、安卓不再弹，
 *   依赖的正是服务端的 read_at。
 */
@AndroidEntryPoint
class NotificationActionReceiver : BroadcastReceiver() {

    @Inject lateinit var messages: MessageRepository
    @Inject lateinit var diagnostics: Diagnostics

    override fun onReceive(context: Context, intent: Intent) {
        val sessionId = intent.getStringExtra(EXTRA_SESSION_ID).orEmpty()
        if (sessionId.isEmpty()) return

        when (intent.action) {
            ACTION_MARK_READ -> {
                val pending = goAsync()
                CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
                    try {
                        messages.markRead(sessionId)
                    } catch (e: Throwable) {
                        diagnostics.debug("notif", "mark read failed ${e.javaClass.simpleName}")
                    } finally {
                        pending.finish()
                    }
                }
            }
            ACTION_DISMISS -> {
                // 划掉通知只是清 UI；不清服务端 read_at（用户没"看过"，内容可能真的没读）。
                val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                nm.cancel(sessionId.hashCode() and 0x7FFF)
            }
        }
    }

    companion object {
        const val ACTION_MARK_READ = "com.echosoul.app.action.MARK_READ"
        const val ACTION_DISMISS = "com.echosoul.app.action.DISMISS"
        const val EXTRA_SESSION_ID = "session_id"

        /** 便捷构造：给 Notifier 的 action 按钮用。 */
        fun markReadIntent(context: Context, sessionId: String): Intent =
            Intent(context, NotificationActionReceiver::class.java)
                .setAction(ACTION_MARK_READ)
                .putExtra(EXTRA_SESSION_ID, sessionId)
    }
}
