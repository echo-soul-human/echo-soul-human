package com.echosoul.app.update

import com.echosoul.app.app.AppConfig
import com.echosoul.app.data.model.AndroidVersion
import com.echosoul.app.data.remote.SupabaseData
import com.echosoul.app.data.remote.str
import com.echosoul.app.diagnostic.Diagnostics
import kotlinx.serialization.json.JsonObject
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * 版本清单读取（架构 §2.7 / 分册 §7）。
 *
 * ★ GET /version **不带 Authorization**：停在进入门的旧构建用户也必须能收到更新提示，
 *   否则低版本用户就卡死在"登录都登不上"的死循环里。
 * ★ 失败一律静默（自动检查不打扰用户）；只有用户手动点「检查更新」才把失败显示出来。
 */
@Singleton
class VersionRepository @Inject constructor(
    private val remote: SupabaseData,
    private val diagnostics: Diagnostics,
) {
    /** 拉清单。失败返回 null，由调用方决定要不要提示。 */
    suspend fun fetch(): AndroidVersion? = withContext(Dispatchers.IO) {
        runCatching { remote.fetchVersion() }
            .onFailure { e -> diagnostics.debug("update", "version fetch failed ${e.javaClass.simpleName}") }
            .getOrNull()
            ?.let { json -> parseAndroid(it) }
    }

    private fun parseAndroid(root: JsonObject): AndroidVersion? {
        val android = root["android"] as? JsonObject ?: return null
        val versionCode = android.str("version_code")?.toIntOrNull() ?: return null
        val url = android.str("url").orEmpty()
        return AndroidVersion(
            versionName = android.str("version_name").orEmpty(),
            versionCode = versionCode,
            url = url,
            sha256 = android.str("sha256").orEmpty().lowercase(),
            size = android.str("size")?.toLongOrNull() ?: 0L,
            minVersionCode = android.str("min_version_code")?.toIntOrNull() ?: 0,
            notes = android.str("notes").orEmpty(),
        )
    }

    /**
     * 是否需要提示：本地 versionCode 低于清单。
     * @param snoozedCode 用户点过「稍后」的那个版本；同一个不再弹。
     */
    fun needsUpdate(remote: AndroidVersion, localCode: Int = AppConfig.versionCode, snoozedCode: Int = 0): Boolean =
        remote.versionCode > localCode && remote.versionCode != snoozedCode

    /**
     * 是否**强制**更新：本地低于 min_version_code。
     * 本地 AppConfig.minVersionCode 是构建期冻结值，清单的 min 是线上最新值 —— 两者取大。
     */
    fun isForced(remote: AndroidVersion, localCode: Int = AppConfig.versionCode): Boolean {
        val floor = maxOf(remote.minVersionCode, AppConfig.minVersionCode)
        return localCode < floor
    }

    /** 下载地址非空且是 https：HTTP 明文下载的 APK 一律拒绝，这是防中间人的底线。 */
    fun isValidDownloadUrl(url: String): Boolean =
        url.isNotBlank() && url.startsWith("https://")
}
