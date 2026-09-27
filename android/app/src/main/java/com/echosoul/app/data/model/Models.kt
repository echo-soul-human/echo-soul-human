package com.echosoul.app.data.model

import com.echosoul.app.api.ChatDone
import com.echosoul.app.api.ChatError
import com.echosoul.app.api.ChatMeta
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * 远端数据模型。
 *
 * ★ 对话协议（ChatRequest / ChatMeta / ChatDelta / ChatDone / ChatError / Usage）
 *   **不在这里**，它在 api/Contract.kt —— 那份由 scripts/gen-contract.mjs 从
 *   shared/contract/api.json 生成，禁止手改（架构 §7.2）。本文件只放数据库行类型。
 *
 * 字段名一律保持 PostgREST 返回的 snake_case 原样：客户端改名 = 抓包、服务端、
 * 客户端三方对不上话，而且这类错误只在运行时才暴露。
 */

@Serializable
data class SessionRow(
    val id: String,
    val kind: String = "solo",
    val title: String? = null,
    @SerialName("last_msg_at") val lastMsgAt: String? = null,
    @SerialName("pinned_at") val pinnedAt: String? = null,
    @SerialName("archived_at") val archivedAt: String? = null,
    @SerialName("character_ids") val characterIds: List<String> = emptyList(),
    @SerialName("character_names") val characterNames: List<String> = emptyList(),
    val preview: String? = null,
    val unread: Int = 0,
)

@Serializable
data class MessageRow(
    val id: String,
    /** user / assistant / system；取值是 DB 枚举 msg_role */
    val role: String,
    @SerialName("character_id") val characterId: String? = null,
    val content: String = "",
    /** client / proactive / imported / system —— 决定通知渠道与气泡样式 */
    val origin: String = "client",
    val partial: Boolean = false,
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("read_at") val readAt: String? = null,
)

@Serializable
data class CharacterRow(
    val id: String,
    val name: String,
    val tagline: String = "",
    @SerialName("avatar_path") val avatarPath: String? = null,
    @SerialName("portrait_path") val portraitPath: String? = null,
    val greeting: String = "",
    @SerialName("persona_text") val personaText: String = "",
    /** 定人设靠示例对话，不靠形容词（002 表注释） */
    @SerialName("example_dialogs") val exampleDialogs: List<List<String>> = emptyList(),
    @SerialName("behavior_notes") val behaviorNotes: String = "",
    val rarity: String? = null,
    val tags: List<String> = emptyList(),
    val visibility: String = "private",
    @SerialName("owner_id") val ownerId: String? = null,
    @SerialName("voice_profile_id") val voiceProfileId: String? = null,
)

@Serializable
data class CreateCharacterArgs(
    val p_name: String,
    val p_tagline: String = "",
    val p_persona: String = "",
    val p_greeting: String = "",
    val p_examples: List<List<String>> = emptyList(),
)

@Serializable
data class PageMessagesArgs(
    val p_session: String,
    val p_before: String? = null,
    val p_limit: Int = 40,
)

/** my_credit() 返回一个 jsonb，形状由服务端决定，客户端只做显示。 */
@Serializable
data class CreditJson(
    val tier: String = "free",
    @SerialName("expires_at") val expiresAt: String? = null,
    @SerialName("credit_expiry") val creditExpiry: String? = null,
    val usable: Double = 0.0,
    val frozen: Double = 0.0,
    val granted: Double = 0.0,
    val spent: Double = 0.0,
    @SerialName("tts_remaining") val ttsRemaining: Double = 0.0,
)

/** byok_profiles_public 视图：★ 没有 encrypted_key 列，也不可能有。key_mask 是唯一可见形态。 */
@Serializable
data class ByokProfileRow(
    val id: String,
    val kind: String,
    val label: String = "",
    @SerialName("base_url") val baseUrl: String = "",
    val model: String = "",
    @SerialName("key_mask") val keyMask: String = "",
    val enabled: Boolean = true,
    @SerialName("last_used_at") val lastUsedAt: String? = null,
)

/** notify_prefs：角色级静音与服务端同步的那一份。 */
@Serializable
data class NotifyPrefsRow(
    @SerialName("user_id") val userId: String,
    @SerialName("care_enabled") val careEnabled: Boolean = true,
    @SerialName("per_character") val perCharacter: Map<String, Boolean> = emptyMap(),
    @SerialName("hide_content") val hideContent: Boolean = false,
)

@Serializable
data class NotifyPrefsPatch(
    val care_enabled: Boolean? = null,
    val per_character: Map<String, Boolean>? = null,
    val hide_content: Boolean? = null,
)

/** push_devices：长连接 client id 注册在这里，服务端按它下发。 */
@Serializable
data class PushDeviceRow(
    val endpoint: String,
    val platform: String = "android",
    val ua: String = "",
    val enabled: Boolean = true,
)

@Serializable
data class AnnouncementRow(
    val id: Long,
    val slug: String,
    val title: String,
    val body: String = "",
    val kind: String = "info",
    @SerialName("starts_at") val startsAt: String = "",
)

/**
 * /version 清单里安卓那一段（架构 §2.7）。
 * 一个接口喂三端，安卓只取自己那段，别的端字段忽略即可。
 */
@Serializable
data class VersionManifest(
    val web: VersionEndpoint? = null,
    val android: AndroidVersion? = null,
)

@Serializable
data class VersionEndpoint(
    val build: String = "",
    val notes: String = "",
    @SerialName("force_refresh") val forceRefresh: Boolean = false,
)

@Serializable
data class AndroidVersion(
    @SerialName("version_name") val versionName: String = "",
    @SerialName("version_code") val versionCode: Int = 0,
    val url: String = "",
    val sha256: String = "",
    val size: Long = 0,
    @SerialName("min_version_code") val minVersionCode: Int = 0,
    val notes: String = "",
)

/** 一轮流式对话在服务端的最终落点（ViewModel 用来失效缓存 + 显示消耗）。 */
sealed interface ChatStreamEvent {
    data class Meta(val meta: ChatMeta) : ChatStreamEvent
    data class Delta(val text: String) : ChatStreamEvent
    data class Done(val done: ChatDone) : ChatStreamEvent
    data class Failed(val error: ChatError) : ChatStreamEvent
    /** 传输层失败（没拿到任何 SSE 事件）。partial=true 时保留已显示文本给"继续"。 */
    data class Transport(val message: String, val partial: Boolean) : ChatStreamEvent
}
