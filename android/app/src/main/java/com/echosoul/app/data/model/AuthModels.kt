package com.echosoul.app.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * 认证相关的数据类。
 *
 * ★ 令牌（access/refresh）不落这个文件的任何类：它们只进 EncryptedSharedPreferences
 *   （见 data/local/AuthStore.kt），且永不出现在诊断日志里 —— Diagnostics 有字段黑名单，
 *   但真正的防线是"根本没有一个携带令牌的 data class 值得被记录"。
 */

@Serializable
data class AuthUser(
    val id: String,
    val email: String? = null,
    @SerialName("is_anonymous") val isAnonymous: Boolean = false,
    @SerialName("created_at") val createdAt: String? = null,
)

@Serializable
data class AuthTokens(
    @SerialName("access_token") val accessToken: String,
    @SerialName("refresh_token") val refreshToken: String,
    @SerialName("token_type") val tokenType: String = "bearer",
    /** expires_in 是相对秒数（GoTrue 的线上形态），不是绝对时间戳。 */
    @SerialName("expires_in") val expiresIn: Long = 3600,
    @SerialName("expires_at") val expiresAt: Long? = null,
) {
    /** 绝对过期时刻（epoch ms）。没有 expires_at 时用 now + expires_in 推。 */
    fun expiryEpochMs(nowMs: Long): Long = expiresAt?.times(1000L) ?: (nowMs + expiresIn * 1000L)
}

@Serializable
data class AuthSession(
    val user: AuthUser,
    val session: AuthTokens,
)

@Serializable
data class SignInAnonBody(
    @SerialName("gotrue_meta_security") val gotrueMetaSecurity: CaptchaMeta = CaptchaMeta(),
)

@Serializable
data class CaptchaMeta(
    val captcha_token: String = "",
    val captcha_provider: String? = null,
)

@Serializable
data class OtpBody(
    val email: String,
    /** 验证码登录而不是密码：少一次"用户记不住"的流失点。 */
    val create_user: Boolean = true,
)

@Serializable
data class VerifyOtpBody(
    val email: String,
    val token: String,
    val type: String = "email",
)

@Serializable
data class RefreshBody(
    val refresh_token: String,
)
