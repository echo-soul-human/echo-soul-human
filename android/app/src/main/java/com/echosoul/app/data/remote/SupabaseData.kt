package com.echosoul.app.data.remote

import com.echosoul.app.api.ChatRequest
import com.echosoul.app.api.Client
import com.echosoul.app.app.AppConfig
import com.echosoul.app.diagnostic.Diagnostics
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.JsonObject
import okhttp3.Request

/**
 * 数据面总入口：Supabase REST / rpc / Storage / Edge Function。
 *
 * ★ 这里不写任何业务规则（架构 §7.1）。余额、权益、群聊人数上限、top_k 一律服务端判；
 *   客户端只做显示与输入。任何"顺手在本地算一下"的写法都会在验收 §15 那七条上翻车。
 */
@Singleton
class SupabaseData @Inject constructor(
    private val http: HttpEngine,
    private val sse: ChatSseClient,
    private val diagnostics: Diagnostics,
) {

    // ─── GET /rpc ────────────────────────────────────────────
    suspend fun selectArr(
        table: String,
        columns: String = "*",
        filters: List<String> = emptyList(),
        order: String? = null,
        limit: Int? = null,
    ): List<JsonObject> = getArray(buildUrl(table, columns, filters, order, limit))

    suspend fun selectOne(
        table: String,
        columns: String = "*",
        filters: List<String> = emptyList(),
    ): JsonObject? = getArray(buildUrl(table, columns, filters, null, 1)).firstOrNull()

    suspend fun rpcArr(fn: String, args: JsonObject): List<JsonObject> = postArray(AppConfig.rpc(fn), args)

    suspend fun rpcJson(fn: String, args: JsonObject): JsonObject =
        post(AppConfig.rpc(fn), args).asObj()

    suspend fun rpcScalarString(fn: String, args: JsonObject): String? {
        val el = post(AppConfig.rpc(fn), args)
        return when (el) {
            is kotlinx.serialization.json.JsonPrimitive -> el.content
            else -> el.asObj().str("result") ?: el.asObj().str("id")
        }
    }

    // ─── PATCH / UPSERT ─────────────────────────────────────
    suspend fun patch(table: String, filter: String, patch: JsonObject): Boolean {
        val req = Request.Builder()
            .url("${AppConfig.rest(table)}?$filter")
            .patch(http.jsonBody(patch.plain()))
            .header("Prefer", "return=minimal")
            .build()
        return http.execute(idempotent = true) { auth(req, it) }.isSuccessful
    }

    suspend fun upsert(table: String, rows: List<JsonObject>, onConflict: String): Boolean {
        val body = kotlinx.serialization.json.JsonArray(rows).plain()
        val req = Request.Builder()
            .url("${AppConfig.rest(table)}?on_conflict=${enc(onConflict)}")
            .post(http.jsonBody(body))
            .header("Prefer", "resolution=merge-duplicates,return=minimal")
            .build()
        return http.execute(idempotent = true) { auth(req, it) }.isSuccessful
    }

    // ─── 会话 / 消息 ────────────────────────────────────────
    /** list_sessions()：排序、未读数、预览全在服务端算好。 */
    suspend fun listSessions(): List<JsonObject> = rpcArr("list_sessions", EMPTY)

    /** open_session(p_character)：已有单聊就复用，避免每次点击都新建。返回 session uuid。 */
    suspend fun openSession(characterId: String): String? =
        rpcScalarString("open_session", buildObject("p_character" to characterId))

    suspend fun createGroup(characterIds: List<String>, title: String?): String? =
        rpcScalarString(
            "create_group",
            buildObject("p_character_ids" to characterIds, "p_title" to (title ?: "")),
        )

    suspend fun pageMessages(sessionId: String, before: String?, limit: Int = 40): List<JsonObject> =
        rpcArr("page_messages", buildObject("p_session" to sessionId, "p_before" to before, "p_limit" to limit))

    /**
     * mark_read(p_session)：一端读过，另一端不再弹（验收 V5-33）。
     * 这是**幂等**的重复调用无害操作，所以允许静默重试。
     */
    suspend fun markRead(sessionId: String): Int {
        val el = post(AppConfig.rpc("mark_read"), buildObject("p_session" to sessionId))
        return (el as? kotlinx.serialization.json.JsonPrimitive)?.content?.toIntOrNull() ?: 0
    }

    /** 补发游标：since 是 ISO-8601 字符串（timestamptz 直接可比较）。 */
    suspend fun messagesSince(sinceIso: String, limit: Int = 200): List<JsonObject> = selectArr(
        table = "messages",
        columns = "id,session_id,role,character_id,content,origin,partial,created_at,read_at",
        filters = listOf("created_at=gt.$sinceIso"),
        order = "created_at.asc",
        limit = limit,
    )

    // ─── 角色 ───────────────────────────────────────────────
    suspend fun characters(limit: Int = 60): List<JsonObject> {
        val uid = http.userIdOrEmpty()
        // 官方卡 owner_id 为 null，始终带上；登录后再叠自己那一档。
        val ownerBranch = if (uid.isEmpty()) "owner_id.is.null" else "owner_id.eq.$uid,owner_id.is.null"
        return selectArr(
            table = "characters",
            columns = "id,name,tagline,avatar_path,portrait_path,greeting,rarity,tags,visibility,owner_id,voice_profile_id",
            filters = listOf(
                // RLS 已经挡掉不该看的，这里的 filter 只是少传字节。
                "or=($ownerBranch,visibility.eq.public)",
            ),
            order = "created_at.desc",
            limit = limit,
        )
    }

    suspend fun character(id: String): JsonObject? = selectOne(
        table = "characters",
        columns = "id,name,tagline,avatar_path,portrait_path,greeting,persona_text,example_dialogs," +
            "behavior_notes,rarity,tags,visibility,owner_id,voice_profile_id,published_version",
        filters = listOf("id=eq.$id"),
    )

    suspend fun createCharacter(
        name: String, tagline: String, persona: String, greeting: String, examples: List<List<String>>,
    ): String? = rpcScalarString(
        "create_character",
        buildObject(
            "p_name" to name, "p_tagline" to tagline, "p_persona" to persona,
            "p_greeting" to greeting, "p_examples" to examples,
        ),
    )

    suspend fun updateCharacter(id: String, fields: JsonObject): Boolean {
        // post() 在非 2xx 时抛 ApiException；rpc 内部已校验 owner（NOT_OWNER），所以这里不重复判。
        post(AppConfig.rpc("update_character"), fields + JsonObject(mapOf("p_id" to kotlinx.serialization.json.JsonPrimitive(id))))
        return true
    }

    // ─── 额度 / BYOK / 通知偏好 ─────────────────────────────
    suspend fun myCredit(): JsonObject = rpcJson("my_credit", EMPTY)

    suspend fun byokProfiles(): List<JsonObject> = selectArr(
        table = "byok_profiles_public",
        columns = "id,kind,label,base_url,model,key_mask,enabled,last_used_at",
        order = "created_at.asc",
    )

    /**
     * 写入 BYOK 配置。★ 明文 Key 只在**这一次请求体**里出现，落库即为信封密文，
     * 之后任何端都只能读到 key_mask（E5/G1 定案）。本方法不留副本、不进诊断日志。
     */
    suspend fun saveByokProfile(kind: String, label: String, baseUrl: String, model: String, apiKey: String) {
        val req = Request.Builder()
            .url("${AppConfig.rest("byok_profiles")}")
            .post(http.jsonBody(buildObject(
                "kind" to kind, "label" to label, "base_url" to baseUrl,
                "model" to model, "api_key" to apiKey,
            ).plain()))
            .header("Prefer", "return=minimal")
            .build()
        http.execute(idempotent = false) { auth(req, it) }
        diagnostics.debug("byok", "profile saved kind=$kind") // 只记 kind，不记内容
    }

    suspend fun deleteByokProfile(id: String): Boolean =
        deleteWhere("byok_profiles", "id=eq.$id")

    suspend fun notifyPrefs(): JsonObject? = selectOne(
        table = "notify_prefs",
        columns = "user_id,care_enabled,per_character,hide_content",
        filters = listOf("user_id=eq.${http.userIdOrEmpty()}"),
    )

    suspend fun saveNotifyPrefs(careEnabled: Boolean?, perCharacter: Map<String, Boolean>?, hideContent: Boolean?) {
        val uid = http.userIdOrEmpty()
        if (uid.isEmpty()) return
        upsert(
            table = "notify_prefs",
            rows = listOf(buildObject(
                "user_id" to uid,
                "care_enabled" to careEnabled,
                "per_character" to perCharacter,
                "hide_content" to hideContent,
            )),
            onConflict = "user_id",
        )
    }

    /** 长连接注册：endpoint 用 clientId，服务端按它下发（§5.1 第 1 层）。 */
    suspend fun registerDevice(clientId: String) {
        val uid = http.userIdOrEmpty()
        if (uid.isEmpty()) return
        upsert(
            table = "push_devices",
            rows = listOf(buildObject(
                "user_id" to uid,
                "platform" to Client.ANDROID.wire,
                "endpoint" to clientId,
                "ua" to deviceUa(),
                "enabled" to true,
            )),
            onConflict = "user_id,endpoint",
        )
    }

    suspend fun announcements(limit: Int = 10): List<JsonObject> = selectArr(
        table = "announcements",
        columns = "id,slug,title,body,kind,starts_at",
        filters = listOf("published=is.true"),
        order = "starts_at.desc",
        limit = limit,
    )

    // ─── 版本清单（应用内更新的入口）────────────────────────
    /**
     * GET /version。**不带 Authorization**：停在登录页的旧构建用户也要能收到更新提示。
     * 失败时抛 ApiException，由 update/ 层决定是静默跳过还是提示（自动检查不打扰用户）。
     */
    suspend fun fetchVersion(): JsonObject {
        val req = Request.Builder().url(AppConfig.functions("version")).get().build()
        return http.client.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) throw ApiException(codeFromStatus(resp.code, text), "version http ${resp.code}")
            parse(text).asObj()
        }
    }

    // ─── 流式对话 ───────────────────────────────────────────
    /**
     * 一轮对话。幂等键来自 [ChatRequest.idempotency_key]：**重试必须复用同一个**，
     * 否则服务端会重复扣费（架构 §2.1）。因此上层不在网络失败时自动重发，
     * 而是把「继续」按钮交给用户，并把同一个 key 再传一次。
     */
    fun streamChat(request: ChatRequest): Flow<SseFrame> {
        val body = buildObject(
            "session_id" to request.session_id,
            "content" to request.content,
            "idempotency_key" to request.idempotency_key,
            "client" to (request.client ?: Client.ANDROID).wire,
            "provider" to request.provider?.let {
                buildObject("kind" to it.kind.wire, "profile_id" to it.profile_id)
            },
            "attachments" to request.attachments,
        ).plain()
        return sse.stream(AppConfig.functions("chat"), body)
    }

    fun resumeChat(messageId: String): Flow<SseFrame> = sse.streamResume(messageId)

    // ─── 内部工具 ───────────────────────────────────────────
    private suspend fun get(url: String) = exchange(Request.Builder().url(url).get().build())

    private suspend fun getArray(url: String): List<JsonObject> = get(url).asArr().objList()

    private suspend fun post(url: String, body: JsonObject) =
        exchange(Request.Builder().url(url).post(http.jsonBody(body.plain())).build())

    private suspend fun postArray(url: String, body: JsonObject): List<JsonObject> =
        post(url, body).asArr().objList()

    private suspend fun deleteWhere(table: String, filter: String): Boolean {
        val req = Request.Builder().url("${AppConfig.rest(table)}?$filter").delete().build()
        return http.execute(idempotent = true) { auth(req, it) }.isSuccessful
    }

    private suspend fun exchange(req: Request): kotlinx.serialization.json.JsonElement =
        http.execute(idempotent = true) { auth(req, it) }.use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) throw ApiException(codeFromStatus(resp.code, text), summarize(text))
            if (text.isBlank()) return@use kotlinx.serialization.json.JsonNull
            parse(text)
        }

    private fun auth(req: Request, token: String): Request =
        req.newBuilder().header("Authorization", "Bearer $token").build()

    private fun parse(text: String): kotlinx.serialization.json.JsonElement =
        runCatching { http.json.parseToJsonElement(text) }
            .getOrElse { throw ApiException("BAD_JSON", text.take(200)) }

    private fun buildUrl(
        table: String, columns: String, filters: List<String>, order: String?, limit: Int?,
    ): String = buildString {
        append(AppConfig.rest(table)).append("?select=").append(enc(columns))
        filters.forEach { append('&').append(it) }
        if (order != null) append("&order=").append(enc(order))
        if (limit != null) append("&limit=").append(limit)
    }

    private fun deviceUa(): String = android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL

    private companion object {
        val EMPTY = JsonObject(emptyMap())
        fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8")
        fun summarize(text: String): String = text.take(160)
    }
}

private val JSON_PLAIN = kotlinx.serialization.json.Json { encodeDefaults = true; explicitNulls = false }

fun JsonObject.plain(): String = JSON_PLAIN.encodeToString(JsonObject.serializer(), this)

fun kotlinx.serialization.json.JsonArray.objList(): List<JsonObject> = mapNotNull { it as? JsonObject }

/**
 * 状态码 → 契约错误码。与网页 lib/sse.ts 的 readErrorCode 逐条对齐（分册 §15），
 * 这样同一账号双端遇到同一故障才会看到同一句话。
 */
internal fun codeFromStatus(status: Int, body: String = ""): String {
    CONTRACT_CODES.firstOrNull { body.contains(it) }?.let { return it }
    return when (status) {
        400 -> "BAD_JSON"
        401 -> "UNAUTHORIZED"
        402 -> "INSUFFICIENT_BALANCE"
        403 -> "NO_ENTITLEMENT"
        404 -> "SESSION_NOT_FOUND"
        405 -> "METHOD_NOT_ALLOWED"
        429 -> "RATE_LIMITED"
        else -> if (status >= 500) "UPSTREAM_5XX" else "UPSTREAM_5XX"
    }
}

private val CONTRACT_CODES = listOf(
    "NETWORK", "RESUME_FAILED", "MODEL_STREAM_BREAK", "BAD_JSON", "EMPTY_CONTENT",
    "CONTENT_TOO_LONG", "METHOD_NOT_ALLOWED", "UNAUTHORIZED", "NO_ENTITLEMENT",
    "SESSION_NOT_FOUND", "SESSION_EMPTY", "INSUFFICIENT_BALANCE", "LEDGER_ERROR",
    "RATE_LIMITED", "BYOK_NOT_FOUND", "ENDPOINT_BLOCKED", "PROVIDER_CONFIG", "UPSTREAM_5XX",
)
