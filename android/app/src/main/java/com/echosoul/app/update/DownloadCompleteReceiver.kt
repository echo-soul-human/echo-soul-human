package com.echosoul.app.update

import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.echosoul.app.data.local.UpdateStore
import com.echosoul.app.diagnostic.Diagnostics
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * DownloadManager 下载完成广播（manifest: `.update.DownloadCompleteReceiver`，exported=false）。
 *
 * ★ 只处理本应用自己入队的 downloadId：系统会把**所有** DOWNLOAD_COMPLETE 都发过来
 *   （包括浏览器下的文件），不比对 id 就会拿别人的下载去校验，必然失败并误删文件。
 *   所以先把 update_pending_download_id（UpdateStore）取出来，id 不匹配直接 return。
 *
 * ★ 校验是 IO（读几十 MB 算 SHA256），不能在 onReceive 主线程做：扔进 IO 作用域异步跑。
 *   本 receiver 的 exported=false + 只接自己的 id，已经是最小暴露面。
 */
@AndroidEntryPoint
class DownloadCompleteReceiver : BroadcastReceiver() {

    @Inject lateinit var updateStore: UpdateStore
    @Inject lateinit var updateManager: UpdateManager
    @Inject lateinit var versionRepository: VersionRepository
    @Inject lateinit var diagnostics: Diagnostics

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != DownloadManager.ACTION_DOWNLOAD_COMPLETE) return
        val finishedId = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
        if (finishedId == -1L) return

        val pending = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                val expected = runCatching { updateStore.pendingApkId.first() }.getOrDefault(-1L)
                if (expected != finishedId) {
                    diagnostics.debug("update", "ignore foreign download $finishedId")
                    return@launch
                }
                val manifest = versionRepository.fetch() ?: return@launch
                // /version 是公开接口且很轻；这里重取一次拿到 sha256 做校验。
                if (manifest.versionCode <= 0) return@launch
                updateManager.verifyAndInstall(finishedId, manifest)
            } finally {
                pending.finish()
            }
        }
    }
}
