package com.echosoul.app.data.repo

import com.echosoul.app.app.AppConfig
import com.echosoul.app.data.local.CursorStore
import com.echosoul.app.data.model.AuthSession
import com.echosoul.app.data.model.AuthTokens
import com.echosoul.app.data.model.AuthUser
import com.echosoul.app.data.remote.ApiException
import com.echosoul.app.data.remote.AuthStore
import com.echosoul.app.data.remote.HttpEngine
import com.echosoul.app.diagnostic.Diagnostics
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.Request

/**
 * 鉴权 Repository：匿名首聊 / 邮箱验证码登录 / 登出。
 *
 * ★ 只做三件事，业务规则全在 GoTrue + RLS：
 *   1. 匿名登录（POST /auth/v1/signup 的 anon 变体）—— "先聊聊"那条路；
 *   2. 邮箱发码 + 验码换会话；
 *   3. 登出时清本地令牌与游标（换账号必须清游标，否则新账号用旧账号时间点补发。
 *
 * ★ 令牌进 AuthStore（EncryptedSharedPreferences），本类**不缓存令牌**、不记录。
 *   密码登录不做：验证码少一次"用户记不住"的流失点（AuthModels.OtpBody 注释）。
 */
@Singleton
class AuthRepository @Inject constructor(
    private val http: HttpEngine,
    private val authStore: AuthStore,
    private val cursorStore: CursorStore,
    private val diagnostics: Diagnostics,
) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }

    val isSignedIn: Boolean get() = authStore.hasSession()

    /** 导航层监听它：令牌刷新失败/被吊销时跳回进入门。 */
    val signedOut: Flow<Unit> get() = authStore.signedOut

    val uid: String? get() = authStore.userId

    /**
     * 匿名登录。失败时抛 [ApiException]，调用方展示 strings.auth_anon_failed。
     */
    suspend fun signInAnonymously(): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            val body = """{"data":{},"gotrue_meta_security":{}}"""
            exchange("/auth/v1/signup", body)
        }.onFailure { e -> diagnostics.debug("auth", "anon failed ${e.javaClass.simpleName}") }
            .isSuccess
    }

    /** 邮箱发验证码。create_user=true：没注册过就顺手注册（少一步）。 */
    suspend fun sendOtp(email: String): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            val body = json.encodeToString(
                com.echosoul.app.data.model.OtpBody.serializer(),
                com.echosoul.app.data.model.OtpBody(email = email),
            )
            postNoSession("/auth/v1/otp", body)
            true
        }.onFailure { e -> diagnostics.debug("auth", "otp failed ${e.javaClass.simpleName}") }
            .getOrDefault(false)
    }

    /** 校验码换会话。成功后令牌即刻落盘。 */
    suspend fun verifyOtp(email: String, token: String): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            val body = json.encodeToString(
                com.echosoul.app.data.model.VerifyOtpBody.serializer(),
                com.echosoul.app.data.model.VerifyOtpBody(email = email, token = token),
            )
            exchange("/auth/v1/verify", body)
        }.onFailure { e -> diagnostics.debug("auth", "verify failed ${e.javaClass.simpleName}") }
            .isSuccess
    }

    /** 登出：清令牌 + 清游标（换账号不清游标会导致新账号重复收历史通知）。 */
    suspend fun signOut() = withContext(Dispatchers.IO) {
        authStore.clear()
        cursorStore.reset()
        authStore.emitSignedOut()
    }

    /** 换账号前调用：清掉上一位用户的本地游标，避免跨账号串消息。 */
    suspend fun resetCursors() = cursorStore.reset()

    // ─── 内部 ───
    private suspend fun exchange(path: String, body: String): AuthSession {
        val raw = postNoSession(path, body)
        return json.decodeFromString(AuthSession.serializer(), raw).also { saveSession(it) }
    }

    private suspend fun postNoSession(path: String, body: String): String {
        val req = Request.Builder()
            .url("${AppConfig.supabaseUrl}$path")
            .header("apikey", AppConfig.anonKey)
            .post(http.jsonBody(body))
            .build()
        http.client.newCall(req).execute().use { res ->
            val text = res.body?.string().orEmpty()
            if (!res.isSuccessful) {
                throw ApiException(if (res.code == 400) "BAD_JSON" else "UNAUTHORIZED", text.take(200))
            }
            return text
        }
    }

    private fun saveSession(session: AuthSession) {
        val user: AuthUser = session.user
        val tokens: AuthTokens = session.session
        authStore.save(user, tokens, System.currentTimeMillis())
    }
}
