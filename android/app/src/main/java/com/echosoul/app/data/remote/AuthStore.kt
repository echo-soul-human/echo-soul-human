package com.echosoul.app.data.remote

import android.content.Context
import androidx.core.content.edit
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.echosoul.app.data.model.AuthTokens
import com.echosoul.app.data.model.AuthUser
import dagger.hilt.android.qualifiers.ApplicationContext
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow

/**
 * 会话令牌与设备标识的落盘处。
 *
 * 三条边界写死在这里：
 *   1. **BYOK API Key 永不进这个文件**（E5/G1 定案：云端托管，安卓只见掩码）。
 *      这里只有 Supabase 的访问/刷新令牌 —— 它回答"你是谁"，额度判断全在服务端 ledger。
 *   2. device_id 首启生成、持久、卸载即重置（分册 §10），用于推送路由与反滥用。
 *   3. 加密存储不可用时降级到普通私有存储而不是崩：丢的只是"要重登一次"，
 *      数据真源在云端（E1 定案），本地从来不是真源。
 */
@Singleton
class AuthStore @Inject constructor(
    @ApplicationContext context: Context,
) {
    private val prefs = runCatching {
        EncryptedSharedPreferences.create(
            context, PREFS_NAME,
            MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }.getOrElse {
        context.getSharedPreferences(PREFS_NAME_FALLBACK, Context.MODE_PRIVATE)
    }

    val accessToken: String? get() = prefs.getString(K_ACCESS, null)
    val refreshToken: String? get() = prefs.getString(K_REFRESH, null)
    val userId: String? get() = prefs.getString(K_UID, null)
    val isAnonymous: Boolean get() = prefs.getBoolean(K_ANON, false)
    val expiresAtMs: Long get() = prefs.getLong(K_EXPIRES, 0L)

    /** 长连接客户端 id，注册进 push_devices.endpoint。 */
    val clientId: String by lazy {
        prefs.getString(K_CLIENT_ID, null)
            ?: UUID.randomUUID().toString().also { id -> prefs.edit { putString(K_CLIENT_ID, id) } }
    }

    val deviceId: String get() = clientId

    fun tokens(): AuthTokens? {
        val a = accessToken ?: return null
        val r = refreshToken ?: return null
        return AuthTokens(accessToken = a, refreshToken = r, expiresAt = expiresAtMs / 1000L)
    }

    fun save(user: AuthUser, t: AuthTokens, nowMs: Long) {
        prefs.edit {
            putString(K_ACCESS, t.accessToken)
            putString(K_REFRESH, t.refreshToken)
            putLong(K_EXPIRES, t.expiryEpochMs(nowMs))
            putString(K_UID, user.id)
            putBoolean(K_ANON, user.isAnonymous)
        }
    }

    fun applyRefreshed(access: String, refresh: String?, expiresAtMs: Long, uid: String?) {
        prefs.edit {
            putString(K_ACCESS, access)
            refresh?.let { putString(K_REFRESH, it) }
            putLong(K_EXPIRES, expiresAtMs)
            uid?.let { putString(K_UID, it) }
        }
    }

    /** 清登录态但保留 clientId：重装前同一台设备还能续上推送路由。 */
    fun clear() {
        prefs.edit {
            remove(K_ACCESS); remove(K_REFRESH); remove(K_EXPIRES); remove(K_UID); remove(K_ANON)
        }
    }

    fun hasSession(): Boolean = !accessToken.isNullOrEmpty() && !userId.isNullOrEmpty()

    /** 过期前 60s 就当作该刷新，避免刚好卡在边界上白失败一轮。 */
    fun needsRefresh(nowMs: Long): Boolean = expiresAtMs - nowMs < REFRESH_LEAD_MS

    /** 401 且刷新也救不回来时广播，由导航层跳回进入门。 */
    val signedOut = MutableSharedFlow<Unit>(extraBufferCapacity = 1, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    fun emitSignedOut() { signedOut.tryEmit(Unit) }

    private companion object {
        const val PREFS_NAME = "echosoul_auth"
        const val PREFS_NAME_FALLBACK = "echosoul_auth_plain"
        const val K_ACCESS = "access_token"
        const val K_REFRESH = "refresh_token"
        const val K_EXPIRES = "expires_at_ms"
        const val K_UID = "user_id"
        const val K_ANON = "is_anon"
        const val K_CLIENT_ID = "client_id"
        const val REFRESH_LEAD_MS = 60_000L
    }
}
