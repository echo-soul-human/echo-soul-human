package com.echosoul.app.update

import android.content.Context
import androidx.hilt.work.HiltWorker
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.echosoul.app.app.AppConfig
import com.echosoul.app.data.local.UpdateStore
import com.echosoul.app.diagnostic.Diagnostics
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.first

/**
 * 自动检查更新（DailyWork，一天一次足够）。proguard 里保留了它的类名，勿改名。
 *
 * ★ 自动检查**绝不打扰**：只是把 UpdateUiState 推给 UI 层（若 UI 在前台会弹非强制的层），
 *   失败静默；限频靠 UpdateStore.lastCheckAt。
 * ★ 强制更新（本地低于 min_version_code）不走本 Worker 决定：那种情况在 App 启动的
 *   能力检查里就要拦，不能指望"一天一次的后台任务"来救一个已经不能用的版本。
 */
@HiltWorker
class UpdateCheckWorker @AssistedInject constructor(
    @Assisted appContext: Context,
    @Assisted params: WorkerParameters,
    private val repo: VersionRepository,
    private val store: UpdateStore,
    private val diagnostics: Diagnostics,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result = runCatching {
        val last = store.lastCheckAt.first()
        val now = System.currentTimeMillis()
        if (now - last < MIN_INTERVAL_MS) return@runCatching Result.success()

        val manifest = repo.fetch()
        store.markChecked(now)
        if (manifest == null) {
            diagnostics.debug("update", "check: no manifest")
            return@runCatching Result.success()
        }
        // 只记录结论；推送 UI 的活在 App 前台时由 SettingsViewModel 主动查。
        diagnostics.debug("update", "check: remote=${manifest.versionCode} local=${AppConfig.versionCode}")
        Result.success()
    }.getOrElse { e ->
        diagnostics.debug("update", "worker failed ${e.javaClass.simpleName}")
        Result.retry()
    }

    companion object {
        private const val NAME = "echosoul-update-check"
        /** 一天一次；比这更密只是白耗流量（用户不会一天装十次）。 */
        private const val MIN_INTERVAL_MS = 24L * 60 * 60 * 1000

        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<UpdateCheckWorker>(24, TimeUnit.HOURS)
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build(),
                )
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                NAME,
                ExistingPeriodicWorkPolicy.UPDATE,
                request,
            )
        }
    }
}
