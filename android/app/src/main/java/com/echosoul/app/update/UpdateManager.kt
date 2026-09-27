package com.echosoul.app.update

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import com.echosoul.app.app.AppConfig
import com.echosoul.app.data.local.UpdateStore
import com.echosoul.app.data.model.AndroidVersion
import com.echosoul.app.diagnostic.Diagnostics
import java.io.File
import java.security.MessageDigest
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext

/**
 * 应用内更新完整链路（F4 定案 / 分册 §7）。
 *
 * ```
 * 拉 /version → 比 versionCode
 *   → 弹层（版本号/说明/大小/稍后/立即）
 *   → 立即 → DownloadManager 后台下载（通知栏：百分比 + MB + 可取消）
 *   → 完成 → SHA256 校验（与 /version 下发值比对）
 *       ├─ 通过 → FileProvider 授权 → 拉起系统安装器
 *       └─ 失败 → 删包 + 提示 + 降级跳浏览器
 *   → 用户取消 → 保留已下载包，下次直接校验安装，不重下
 * ```
 *
 * ★ 为什么用 DownloadManager 而非 OkHttp：系统级、断点续传、省电、通知栏进度自带，
 *   取消按钮也由系统提供，省掉一整套通知进度样板。
 * ★ SHA256 **必须校验**：不校验等于让用户装任意被替换的 APK。
 * ★ 下载目录固定在 cacheDir/apk（file_paths.xml 只共享这一层），不用外部存储：
 *   外部存储需要额外权限且清理时机不可控。
 */
@Singleton
class UpdateManager @Inject constructor(
    private val store: UpdateStore,
    private val diagnostics: Diagnostics,
    @dagger.hilt.android.qualifiers.ApplicationContext private val context: Context,
) {
    private val _state = MutableStateFlow<UpdateUiState>(UpdateUiState.Idle)
    val state: StateFlow<UpdateUiState> = _state.asStateFlow()

    private val dm: DownloadManager
        get() = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager

    /** 下载落盘目录（cacheDir/apk）。file_paths.xml 的 cache-path name="apk" 正对它。 */
    fun apkDir(): File = File(context.cacheDir, "apk").apply { if (!exists()) mkdirs() }

    fun apkFile(versionCode: Int): File = File(apkDir(), "echosoul-$versionCode.apk")

    // ─── 1. 发起下载 ────────────────────────────────────────
    /**
     * 用 DownloadManager 排队下载。返回 downloadId（存进 UpdateStore，取消后下次直接校验）。
     * @return -1 表示 URL 非法或入队失败。
     */
    fun enqueue(version: AndroidVersion): Long {
        if (!isSafeUrl(version.url)) {
            diagnostics.warn("update", "unsafe url rejected")
            return -1L
        }
        val target = apkFile(version.versionCode)
        // 复用上次没下完的包：DownloadManager 支持断点续传（目标文件已存在时按 Range 续）。
        val request = DownloadManager.Request(Uri.parse(version.url))
            .setTitle(context.getString(com.echosoul.app.R.string.update_available, version.versionName))
            .setDescription(context.getString(com.echosoul.app.R.string.update_channel_name))
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setAllowedOverMetered(true)
            .setAllowedOverRoaming(false)
            // ★ 目标固定在 cacheDir/apk（file_paths.xml 只共享这一层，FileProvider 才能授权）。
            //   不用外部存储：需要额外权限，且系统清理时机不可控。
            .setDestinationUri(Uri.fromFile(target))
        return runCatching {
            dm.enqueue(request).also { id ->
                _state.value = UpdateUiState.Downloading(id, 0, version.size)
            }
        }.getOrElse { e ->
            diagnostics.warn("update", "enqueue failed ${e.javaClass.simpleName}")
            -1L
        }
    }

    /** 下载进度：百分比 + 已下 MB / 总 MB。UI 与常驻通知都读它。 */
    fun progress(downloadId: Long): DownloadProgress? {
        val q = DownloadManager.Query().setFilterById(downloadId)
        return runCatching {
            dm.query(q)?.use { c ->
                if (!c.moveToFirst()) return@use null
                val total = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
                val done = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
                val status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                val pct = if (total > 0) ((done * 100) / total).toInt() else 0
                DownloadProgress(downloadId, status, pct, done, total)
            }
        }.getOrNull()
    }

    fun cancel(downloadId: Long) {
        runCatching { dm.remove(downloadId) }
        // ★ 取消**不删包**：保留已下部分，下次直接校验安装，不重下（§7）。
        _state.value = UpdateUiState.Canceled
    }

    // ─── 2. 完成后校验 + 安装 ───────────────────────────────
    /**
     * 下载完成后调用。校验 SHA256：
     *   通过 → 拉起安装器；
     *   不通过 → 删包 + 降级跳浏览器 + 提示。
     */
    suspend fun verifyAndInstall(downloadId: Long, version: AndroidVersion): Boolean =
        withContext(Dispatchers.IO) {
            val file = apkFile(version.versionCode)
            if (!file.exists()) {
                _state.value = UpdateUiState.Failed(Reason.NOT_FOUND)
                return@withContext false
            }
            val expected = version.sha256.lowercase().trim()
            if (expected.isBlank()) {
                // 清单没给哈希：不能装（宁可让用户走浏览器，也不装一个无法验证的包）。
                diagnostics.warn("update", "manifest without sha256")
                return@withContext fallbackToBrowser(version, Reason.NO_HASH)
            }
            val actual = sha256Of(file)
            if (actual == null || !actual.equals(expected, ignoreCase = true)) {
                diagnostics.warn("update", "hash mismatch expected=${expected.take(8)}.. actual=${actual?.take(8)}..")
                // ★ 校验失败必须删包：留着它下次还会被"直接安装"命中，等于留了个后门。
                file.delete()
                store.clearPendingApkId()
                return@withContext fallbackToBrowser(version, Reason.HASH_MISMATCH)
            }

            store.clearPendingApkId()
            _state.value = UpdateUiState.Ready(version)
            launchInstaller(file)
            true
        }

    /** 取消过下载、包仍在缓存时：跳过下载，直接走校验安装（§7 的"下次直接校验安装"）。 */
    suspend fun verifyPendingIfAny(version: AndroidVersion): Boolean = withContext(Dispatchers.IO) {
        val file = apkFile(version.versionCode)
        if (file.exists() && file.length() > 0) verifyAndInstall(-1L, version) else false
    }

    /**
     * 拉起系统安装器。需要 REQUEST_INSTALL_PACKAGES（用户点更新时才引导授予）。
     * @return false = 没有安装权限，调用方去引导系统设置页。
     */
    fun launchInstaller(file: File): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
            _state.value = UpdateUiState.NeedInstallPermission
            return false
        }
        val uri = FileProvider.getUriForFile(
            context,
            "${AppConfig.applicationId}.fileprovider",
            file,
        )
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, APK_MIME)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return runCatching { context.startActivity(intent); true }
            .getOrElse { e ->
                diagnostics.warn("update", "install intent failed ${e.javaClass.simpleName}")
                false
            }
    }

    /** 点「立即更新」但没权限：跳系统"安装未知应用"授权页（MANIFEST 的 queries 已声明该 action）。 */
    fun openInstallPermissionSettings() {
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
            .setData(Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        runCatching { context.startActivity(intent) }
            .onFailure { e -> diagnostics.warn("update", "open install settings failed ${e.javaClass.simpleName}") }
    }

    /** 校验失败/无哈希的降级：跳浏览器下载（同域 Storage 链接）。 */
    private fun fallbackToBrowser(version: AndroidVersion, reason: Reason): Boolean {
        _state.value = UpdateUiState.Failed(reason)
        val ok = runCatching {
            context.startActivity(
                Intent(Intent.ACTION_VIEW, Uri.parse(version.url))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            true
        }.getOrElse { false }
        return ok
    }

    // ─── 3. SHA256 ──────────────────────────────────────────
    private fun sha256Of(file: File): String? = runCatching {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(1 shl 16)
            while (true) {
                val n = input.read(buf)
                if (n <= 0) break
                digest.update(buf, 0, n)
            }
        }
        digest.digest().joinToString("") { "%02x".format(it) }
    }.getOrElse { e ->
        diagnostics.warn("update", "hash read failed ${e.javaClass.simpleName}")
        null
    }

    private fun isSafeUrl(url: String): Boolean = url.startsWith("https://")

    data class DownloadProgress(
        val downloadId: Long,
        val status: Int,
        val percent: Int,
        val bytesDownloaded: Long,
        val bytesTotal: Long,
    ) {
        val done: Boolean get() = status == DownloadManager.STATUS_SUCCESSFUL
        val failed: Boolean get() = status == DownloadManager.STATUS_FAILED
        fun mb(bytes: Long): String = String.format(java.util.Locale.US, "%.1f", bytes / 1024.0 / 1024.0)
    }

    enum class Reason { NOT_FOUND, NO_HASH, HASH_MISMATCH }

    private companion object {
        const val APK_MIME = "application/vnd.android.package-archive"
    }
}
