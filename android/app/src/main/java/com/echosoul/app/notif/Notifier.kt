package com.echosoul.app.notif

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationChannelGroup
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.echosoul.app.R
import com.echosoul.app.data.local.CachedMessage
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * 通知：渠道分组、同角色合并、角色级静音、锁屏可隐藏内容（分册 §6）。
 *
 * ★ 三条铁律：
 *   1. **正文由服务端下发**，客户端不拼文案 —— 否则改一个字就要发版。
 *      （唯一例外是结构性文案："TA 给你发了 3 条消息"。）
 *   2. 到期提醒不得用施压话术（"失去 TA""TA 会忘记你"）—— 这是 D1 定案，也是留存的正道。
 *   3. 每个渠道都要能单独关，还要有角色级静音。这品类的用户会主动管理通知，做不到会被骂。
 */
@Singleton
class Notifier @Inject constructor(
    @ApplicationContext private val context: Context,
    private val prefs: NotifyPrefs,
) {
    private val manager = NotificationManagerCompat.from(context)

    /** 建渠道必须在任何 notify 之前；Android 8+ 没建渠道的 notify 是静默失败。 */
    fun ensureChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        nm.createNotificationChannelGroup(
            NotificationChannelGroup(GROUP_CHARACTER, context.getString(R.string.chan_group_character)),
        )
        nm.createNotificationChannelGroup(
            NotificationChannelGroup(GROUP_TRADE, context.getString(R.string.chan_group_trade)),
        )

        // 主动关怀：DEFAULT，可静音可单独关
        nm.createNotificationChannel(
            NotificationChannel(CHAN_CARE, context.getString(R.string.chan_care_name), NotificationManager.IMPORTANCE_DEFAULT).apply {
                group = GROUP_CHARACTER
                description = context.getString(R.string.chan_care_desc)
                enableVibration(true)
                vibrationEffect = VIBRATE_LIGHT
                setSound(
                    android.provider.Settings.System.DEFAULT_NOTIFICATION_URI,
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
            },
        )
        // 对话回复：LOW —— 应用内前台时不该响
        nm.createNotificationChannel(
            NotificationChannel(CHAN_REPLY, context.getString(R.string.chan_reply_name), NotificationManager.IMPORTANCE_LOW).apply {
                group = GROUP_CHARACTER
                description = context.getString(R.string.chan_reply_desc)
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CHAN_SYSTEM, context.getString(R.string.chan_system_name), NotificationManager.IMPORTANCE_DEFAULT).apply {
                group = GROUP_CHARACTER
                description = context.getString(R.string.chan_system_desc)
            },
        )
        // 权益到期：HIGH（唯一的 HIGH），但文案不吓人
        nm.createNotificationChannel(
            NotificationChannel(CHAN_EXPIRE, context.getString(R.string.chan_expire_name), NotificationManager.IMPORTANCE_HIGH).apply {
                group = GROUP_TRADE
                description = context.getString(R.string.chan_expire_desc)
            },
        )
        // 常驻服务通知：MIN + 独立渠道，可在设置里关（§5.2）
        nm.createNotificationChannel(
            NotificationChannel(CHAN_SERVICE, context.getString(R.string.chan_service_name), NotificationManager.IMPORTANCE_MIN).apply {
                setShowBadge(false)
                description = context.getString(R.string.chan_service_desc)
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CHAN_UPDATE, context.getString(R.string.update_channel_name), NotificationManager.IMPORTANCE_LOW),
        )
    }

    /**
     * 按消息决定弹哪个渠道 / 要不要弹。
     *
     * 静音优先级：角色级静音 > 主动关怀总开关 > 渠道本身。
     * read_at 非空说明另一端已经读过 → 不再弹（多端不重复提醒，验收 V5-33）。
     */
    fun notifyIfNeeded(msg: CachedMessage) {
        if (msg.readAt != null) return
        if (msg.role != "assistant") return
        val characterId = msg.characterId
        if (characterId != null && prefs.isMuted(characterId)) return

        val channel = when {
            msg.origin == "proactive" -> {
                if (!prefs.careEnabled) return
                CHAN_CARE
            }
            msg.origin == "imported" -> return // 欢迎语不是新消息
            else -> CHAN_REPLY
        }
        postForCharacter(channel, msg)
    }

    /** 同一角色的多条合并成一条 InboxStyle（§6.2）。 */
    private fun postForCharacter(channel: String, msg: CachedMessage) {
        val name = msg.characterId?.let { prefs.nameOf(it) } ?: "TA"
        val pending = recentOf(msg.sessionId, msg.characterId)

        val builder = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat_message)
            .setGroup(GROUP_CHARACTER)
            .setAutoCancel(true)
            .setContentIntent(openSessionIntent(msg.sessionId))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(
                // 锁屏可隐藏：只留"有新消息"（§6.2，防旁人看到对话内容）
                if (prefs.hideContent) Notification.VISIBILITY_SECRET
                else Notification.VISIBILITY_PRIVATE
            )

        if (pending.size >= 2) {
            val inbox = NotificationCompat.InboxStyle()
            pending.takeLast(MAX_LINES).forEach { inbox.addLine(previewText(it)) }
            inbox.setBigText(pending.joinToString("\n") { previewText(it) })
            builder.setContentTitle(context.getString(R.string.notif_multi_count, name, pending.size))
                .setStyle(inbox)
                .setContentText(previewText(pending.last()))
        } else {
            builder.setContentTitle(name)
                .setStyle(NotificationCompat.BigTextStyle().bigText(previewText(msg)))
                .setContentText(previewText(msg))
        }
        if (prefs.vibrate && channel == CHAN_CARE) builder.setVibrate(VIBRATE_PATTERN)

        manager.notify(msg.notificationId(), builder.build())
    }

    /** 系统层"是否允许弹通知"的判断交给调用方（POST_NOTIFICATIONS 运行时权限）。 */
    fun canPost(): Boolean = manager.areNotificationsEnabled()

    fun cancel(id: Int) = manager.cancel(id)

    fun systemNotify(title: String, body: String, highImportance: Boolean = false) {
        val n = NotificationCompat.Builder(context, if (highImportance) CHAN_EXPIRE else CHAN_SYSTEM)
            .setSmallIcon(R.drawable.ic_stat_message)
            .setGroup(GROUP_TRADE)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .build()
        manager.notify(System.currentTimeMillis().toInt() and 0x7FFF, n)
    }

    private fun previewText(msg: CachedMessage): String =
        if (prefs.hideContent) context.getString(R.string.notif_new_message)
        else msg.content.replace('\n', ' ').take(160)

    /**
     * 同会话同角色的最近若干条（用于合并显示）。
     * 上限很小：这是一份内存里的滑动窗口，不是第二个缓存层。
     */
    private val recent = LinkedHashMap<String, MutableList<CachedMessage>>()

    private fun recentOf(sessionId: String, characterId: String?): List<CachedMessage> = synchronized(recent) {
        recent["$sessionId|${characterId ?: "-"}"]?.toList() ?: listOf()
    }

    fun rememberForMerge(msg: CachedMessage) {
        synchronized(recent) {
            val key = "${msg.sessionId}|${msg.characterId ?: "-"}"
            val list = recent.getOrPut(key) { mutableListOf() }
            if (list.none { it.id == msg.id }) list += msg
            while (list.size > MAX_WINDOW) list.removeAt(0)
            while (recent.size > MAX_KEYS) recent.remove(recent.keys.first())
        }
    }

    fun clearMerge(sessionId: String) {
        synchronized(recent) { recent.keys.removeAll { it.startsWith("$sessionId|") } }
    }

    private fun openSessionIntent(sessionId: String): PendingIntent {
        val intent = Intent(context, com.echosoul.app.app.MainActivity::class.java).apply {
            action = ACTION_OPEN_SESSION
            putExtra(EXTRA_SESSION_ID, sessionId)
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        return PendingIntent.getActivity(
            context, sessionId.hashCode(), intent,
            // IMMUTABLE 从 Android 12 起是安全要求；FLAG_UPDATE_CURRENT 保证换会话时 extras 跟着变。
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private companion object {
        const val GROUP_CHARACTER = "group_character"
        const val GROUP_TRADE = "group_trade"
        const val CHAN_CARE = "chan_care"
        const val CHAN_REPLY = "chan_reply"
        const val CHAN_SYSTEM = "chan_system"
        const val CHAN_EXPIRE = "chan_expire"
        const val CHAN_SERVICE = "chan_service"
        const val CHAN_UPDATE = "chan_update"
        const val ACTION_OPEN_SESSION = "com.echosoul.app.action.OPEN_SESSION"
        const val EXTRA_SESSION_ID = "session_id"
        const val MAX_LINES = 5
        const val MAX_WINDOW = 8
        const val MAX_KEYS = 12
        val VIBRATE_PATTERN = longArrayOf(0, 40, 80, 40)

        /** minSdk 26，VibrationEffect 可直接用。振幅 80 是"轻"的手感：关怀不该像告警。 */
        val VIBRATE_LIGHT = android.os.VibrationEffect.createOneShot(40, 80)
    }
}

/** 通知 id：按消息 id 稳定映射，重复到达就是同一条通知而不是叠两条。 */
fun CachedMessage.notificationId(): Int = id.hashCode() and 0x7FFF

const val NOTIF_EXTRA_SESSION = "session_id"
