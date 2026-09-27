package com.echosoul.app.data.repo

import com.echosoul.app.data.local.CachedMessage
import com.echosoul.app.data.model.ByokProfileRow
import com.echosoul.app.data.model.CharacterRow
import com.echosoul.app.data.model.CreditJson
import com.echosoul.app.data.model.MessageRow
import com.echosoul.app.data.model.NotifyPrefsRow
import com.echosoul.app.data.remote.boolMap
import com.echosoul.app.data.remote.boolOr
import com.echosoul.app.data.remote.doubleOr
import com.echosoul.app.data.remote.intOr
import com.echosoul.app.data.remote.nestedStrList
import com.echosoul.app.data.remote.str
import com.echosoul.app.data.remote.strList
import com.echosoul.app.data.remote.strOr
import kotlinx.serialization.json.JsonObject

/**
 * JsonObject → 领域模型 的唯一转换点。
 *
 * ★ 为什么不直接把 JsonObject 丢给 UI：字段名拼错（`avatar_path` 写成 `avatarPath`）
 *   在 Kotlin 里是合法的 map key，编译器不报错，只在运行时静默变空 ——
 *   集中在这一层转换，拼错一次就在一处暴露，而不是散落十几个页面各错各的。
 */

fun JsonObject.toMessageRow(): MessageRow = MessageRow(
    id = strOr("id"),
    role = strOr("role", "assistant"),
    characterId = str("character_id"),
    content = strOr("content"),
    origin = strOr("origin", "client"),
    partial = boolOr("partial", false),
    createdAt = strOr("created_at"),
    readAt = str("read_at"),
)

fun JsonObject.toCharacterRow(): CharacterRow = CharacterRow(
    id = strOr("id"),
    name = strOr("name"),
    tagline = strOr("tagline"),
    avatarPath = str("avatar_path"),
    portraitPath = str("portrait_path"),
    greeting = strOr("greeting"),
    personaText = strOr("persona_text"),
    exampleDialogs = nestedStrList("example_dialogs"),
    behaviorNotes = strOr("behavior_notes"),
    rarity = str("rarity"),
    tags = strList("tags"),
    visibility = strOr("visibility", "private"),
    ownerId = str("owner_id"),
    voiceProfileId = str("voice_profile_id"),
)

fun JsonObject.toCreditJson(): CreditJson = CreditJson(
    tier = strOr("tier", "free"),
    expiresAt = str("expires_at"),
    creditExpiry = str("credit_expiry"),
    usable = doubleOr("usable"),
    frozen = doubleOr("frozen"),
    granted = doubleOr("granted"),
    spent = doubleOr("spent"),
    ttsRemaining = doubleOr("tts_remaining"),
)

fun JsonObject.toByokProfileRow(): ByokProfileRow = ByokProfileRow(
    id = strOr("id"),
    kind = strOr("kind"),
    label = strOr("label"),
    baseUrl = strOr("base_url"),
    model = strOr("model"),
    keyMask = strOr("key_mask"),
    enabled = boolOr("enabled", true),
    lastUsedAt = str("last_used_at"),
)

fun JsonObject.toNotifyPrefsRow(userId: String): NotifyPrefsRow = NotifyPrefsRow(
    userId = strOr("user_id", userId),
    careEnabled = boolOr("care_enabled", true),
    perCharacter = boolMap("per_character"),
    hideContent = boolOr("hide_content", false),
)

/**
 * 服务端消息 → 本地渲染缓存行。
 *
 * ★ origin=imported 是欢迎语、origin=proactive 是主动关怀：两者都要保留 origin，
 *   否则 Notifier 会把欢迎语当新消息弹（Notifier.notifyIfNeeded 靠它判）。
 */
fun MessageRow.toCached(sessionId: String, cachedAt: Long): CachedMessage = CachedMessage(
    id = id,
    sessionId = sessionId,
    role = role,
    characterId = characterId,
    content = HtmlSafe.plain(content),
    origin = origin,
    partial = partial,
    createdAt = createdAt,
    readAt = readAt,
    cachedAt = cachedAt,
)

/** 会话索引行的整表替换来源。逗号串是本地存储形态，见 SessionIndexEntity 注释。 */
fun JsonObject.toSessionIndexColumns(): SessionIndexColumns = SessionIndexColumns(
    id = strOr("id"),
    kind = strOr("kind", "solo"),
    title = str("title"),
    characterIds = strList("character_ids"),
    characterNames = strList("character_names"),
    preview = str("preview"),
    unread = intOr("unread"),
    lastMsgAt = str("last_msg_at"),
)

data class SessionIndexColumns(
    val id: String,
    val kind: String,
    val title: String?,
    val characterIds: List<String>,
    val characterNames: List<String>,
    val preview: String?,
    val unread: Int,
    val lastMsgAt: String?,
)
