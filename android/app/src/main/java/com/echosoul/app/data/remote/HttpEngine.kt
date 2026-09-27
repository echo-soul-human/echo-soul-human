package com.echosoul.app.data.remote

import android.os.Build
import com.echosoul.app.api.Client
import com.echosoul.app.app.AppConfig
import com.echosoul.app.diagnostic.Diagnostics
import java.io.IOException
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/**
 * 唯一的 HTTP 出口（分册 §3：禁止各处 new OkHttpClient）。
 *
 * ★ 这里没有任何形式的证书绕过：不自定义 X509TrustManager、不设 hostnameVerifier、
 *   不放开 cleartext。"内网调试方便一下"留下的口子在生产上就是中间人，
 *   CI 的 secret-scan / 代码审查拦的就是这类写法。
 */
@Singleton
class HttpEngine @Inject constructor(
    private val authStore: AuthStore,
    private val diagnostics: Diagnostics,
) {
    val json = Json {
        // 服务端加字段不能把旧客户端打断（api.json 里 ChatError.code 留 string 同理）。
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    }

    val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(AppConfig.Timeouts.CONNECT_MS.toLong(), TimeUnit.MILLISECONDS)
            .readTimeout(AppConfig.Timeouts.READ_JSON_MS.toLong(), TimeUnit.MILLISECONDS)
            .writeTimeout(AppConfig.Timeouts.WRITE_MS.toLong(), TimeUnit.MILLISECONDS)
            .retryOnConnectionFailure(true)
            .addInterceptor(HeaderInterceptor(authStore))
            .build()
    }

    /** 流式专用：读超时给足 120s，否则长回答会被掐（分册 §3）。 */
    val streamingClient: OkHttpClient by lazy {
        client.newBuilder()
            .readTimeout(AppConfig.Timeouts.READ_STREAM_MS.toLong(), TimeUnit.MILLISECONDS)
            .callTimeout(0L, TimeUnit.MILLISECONDS)
            .build()
    }

    val deviceId: String get() = authStore.deviceId

    /** 供 REST filter 拼 owner 条件用；未登录时返回空串，调用方自己决定跳过。 */
    fun userIdOrEmpty(): String = authStore.userId.orEmpty()

    val isSignedIn: Boolean get() = authStore.hasSession()

    fun jsonBody(text: String) = text.toRequestBody(JSON_MEDIA)

    fun request(url: String, bodyJson: String?, accept: String? = null): Request =
        Request.Builder()
            .url(url)
            .apply { if (accept != null) header("accept", accept) }
            .apply {
                if (bodyJson == null) get() else post(jsonBody(bodyJson))
            }
            .build()

    /**
     * 带 Bearer 地执行一次调用；401 时刷新令牌并重放**一次**。
     *
     * @param idempotent 只有幂等请求（GET / rpc-read）才允许静默重放。
     *   POST /chat 必须传 false —— 它的重试只能由用户点「继续」并复用同一
     *   idempotency_key 完成，静默重放会让服务端重复扣费。
     */
    suspend fun execute(idempotent: Boolean = true, build: (String) -> Request): Response {
        val token = currentToken()
        val first = runCatching { client.newCall(build(token)).execute() }
            .getOrElse { throw NetworkIOException(it) }
        if (first.code != 401) return first
        first.close()
        if (!idempotent) throw UnauthorizedException()
        val fresh = forceRefresh() ?: run {
            authStore.emitSignedOut()
            throw UnauthorizedException()
        }
        val second = runCatching { client.newCall(build(fresh)).execute() }
            .getOrElse { throw NetworkIOException(it) }
        if (second.code == 401) {
            second.close()
            authStore.clear()
            authStore.emitSignedOut()
            throw UnauthorizedException()
        }
        return second
    }

    suspend fun currentToken(): String {
        val cached = authStore.accessToken
        val now = System.currentTimeMillis()
        if (!cached.isNullOrEmpty() && !authStore.needsRefresh(now)) return cached
        if (authStore.refreshToken.isNullOrEmpty()) throw UnauthorizedException()
        return forceRefresh() ?: throw UnauthorizedException()
    }

    private val refreshMutex = Mutex()

    private suspend fun forceRefresh(): String? = refreshMutex.withLock {
        val rt = authStore.refreshToken ?: return@withLock null
        val body = """{"refresh_token":"${esc(rt)}"}"""
        val req = Request.Builder()
            .url("${AppConfig.supabaseUrl}/auth/v1/token?grant_type=refresh_token")
            .header("apikey", AppConfig.anonKey)
            .post(jsonBody(body))
            .build()
        try {
            client.newCall(req).execute().use { res ->
                if (!res.isSuccessful) {
                    // 明确被拒才清态：多半是另一端刷过令牌。让用户重进，不死循环重试。
                    diagnostics.warn("auth", "refresh rejected http=${res.code}")
                    authStore.clear()
                    authStore.emitSignedOut()
                    return@use null
                }
                val parsed = runCatching {
                    json.decodeFromString<RefreshResponse>(res.body?.string().orEmpty())
                }.getOrNull() ?: return@use null
                authStore.applyRefreshed(
                    access = parsed.access_token,
                    refresh = parsed.refresh_token,
                    expiresAtMs = System.currentTimeMillis() + parsed.expires_in * 1000L,
                    uid = parsed.user?.id,
                )
                parsed.access_token
            }
        } catch (e: IOException) {
            // 网络抖动不该顺手清掉登录态。
            diagnostics.warn("auth", "refresh io ${e.javaClass.simpleName}")
            null
        }
    }

    private companion object {
        val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
        fun esc(s: String): String = s.replace("\\", "\\\\").replace("\"", "\\\"")
    }
}

class UnauthorizedException : IOException("UNAUTHORIZED")

class NetworkIOException(cause: Throwable) : IOException("NETWORK", cause)

private class HeaderInterceptor(private val authStore: AuthStore) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val original = chain.request()
        val builder = original.newBuilder()
            .header("X-Client", Client.ANDROID.wire)
            .header("X-Build", AppConfig.versionCode.toString())
            .header("X-Device-Id", authStore.deviceId)
            .header("User-Agent", UA)
        // apikey 对 Supabase 网关必需：它和 Authorization 一起决定 RLS 走哪个角色。
        if (original.header("apikey") == null) builder.header("apikey", AppConfig.anonKey)
        if (original.header("x-client-info") == null) builder.header("x-client-info", CLIENT_INFO)
        return chain.proceed(builder.build())
    }

    private companion object {
        const val CLIENT_INFO = "echosoul-android"
        val UA = "EchoSoul/${AppConfig.versionName} Android/${Build.VERSION.RELEASE}"
    }
}

@Serializable
private data class RefreshResponse(
    val access_token: String,
    val refresh_token: String? = null,
    val expires_in: Long = 3600,
    val user: LiteUser? = null,
)

@Serializable
private data class LiteUser(val id: String? = null)
