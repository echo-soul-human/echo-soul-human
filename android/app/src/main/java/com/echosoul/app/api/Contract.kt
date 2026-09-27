package com.echosoul.app.api

// 由 scripts/gen-contract.mjs 从 shared/contract/api.json 生成，禁止手改。
// 字段名保持线上协议的 snake_case：一旦安卓侧改成驼峰，抓包、服务端与客户端就对不上话。

enum class Client(val wire: String) {
    WEB("web"),
    ANDROID("android"),
    IOS_WEBAPP("ios-webapp"),
}

enum class Tier(val wire: String) {
    FREE("free"),
    LITE("lite"),
    PRO("pro"),
    PRO_PLUS("pro_plus"),
    ULTRA("ultra"),
}

enum class ProviderKind(val wire: String) {
    OPENAI("openai"),
    ANTHROPIC("anthropic"),
}

enum class ErrorCode(val wire: String) {
    NETWORK("NETWORK"),
    RESUME_FAILED("RESUME_FAILED"),
    MODEL_STREAM_BREAK("MODEL_STREAM_BREAK"),
    BAD_JSON("BAD_JSON"),
    EMPTY_CONTENT("EMPTY_CONTENT"),
    CONTENT_TOO_LONG("CONTENT_TOO_LONG"),
    METHOD_NOT_ALLOWED("METHOD_NOT_ALLOWED"),
    UNAUTHORIZED("UNAUTHORIZED"),
    NO_ENTITLEMENT("NO_ENTITLEMENT"),
    SESSION_NOT_FOUND("SESSION_NOT_FOUND"),
    SESSION_EMPTY("SESSION_EMPTY"),
    INSUFFICIENT_BALANCE("INSUFFICIENT_BALANCE"),
    LEDGER_ERROR("LEDGER_ERROR"),
    RATE_LIMITED("RATE_LIMITED"),
    BYOK_NOT_FOUND("BYOK_NOT_FOUND"),
    ENDPOINT_BLOCKED("ENDPOINT_BLOCKED"),
    PROVIDER_CONFIG("PROVIDER_CONFIG"),
    UPSTREAM_5XX("UPSTREAM_5XX"),
}

data class Usage(
    val promptTokens: Int,
    val completionTokens: Int,
    val cachedTokens: Int
)

data class ByokRef(
    val kind: ProviderKind,
    val profile_id: String
)

data class ChatRequest(
    val session_id: String,
    val content: String,
    val idempotency_key: String,
    val client: Client? = null,
    val provider: ByokRef? = null,
    val attachments: List<String>? = null
)

data class ChatMeta(
    val message_id: String,
    val user_message_id: String? = null,
    val model: String,
    val provider: String,
    val frozen: Double,
    val carried_tokens: Int,
    val byok: Boolean,
    val replay: Boolean? = null
)

data class ChatDelta(
    val t: String
)

data class ChatDone(
    val usage: Usage? = null,
    val settled: Double? = null,
    val refunded: Double? = null,
    val balance: Double? = null,
    val cache_hit: Boolean? = null,
    val replay: Boolean? = null
)

data class ChatError(
    val code: String,
    val msg: String,
    val partial: Boolean? = null
)
