package com.echosoul.app.realtime

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
import com.echosoul.app.diagnostic.Diagnostics
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import java.util.concurrent.TimeUnit

/**
 * 兜底补拉（§5.1 第 2 层）。
 *
 * 即使长连接全挂、进程被杀，WorkManager 周期性醒来按 last_seen_at 补一次，
 * 消息最迟半小时到。周期 20 分钟（AppConfig.Realtime.FALLBACK_SYNC_MINUTES）——
 * 比 15 分钟宽松一点，避免在低端机上被系统当成耗电大户限制调度。
 *
 * ★ 约束网络为 CONNECTED：没网醒来只会白跑一次并消耗 Doze 额度。
 * ★ 不做开机自启（Manifest 有意不声明 RECEIVE_BOOT_COMPLETED）：WorkManager 会在
 *   设备重启后自行恢复周期任务，无需我们额外唤醒。
 */
@HiltWorker
class SyncWorker @AssistedInject constructor(
    @Assisted appContext: Context,
    @Assisted params: WorkerParameters,
    private val sync: SyncCoordinator,
    private val diagnostics: Diagnostics,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result = runCatching {
        val n = sync.backfill()
        diagnostics.debug("sync", "worker backfilled $n")
        Result.success()
    }.getOrElse { e ->
        diagnostics.debug("sync", "worker failed ${e.javaClass.simpleName}")
        // 网络类抖动让 WorkManager 稍后重试；其他错误也不 fatal，下个周期还会来。
        Result.retry()
    }

    companion object {
        private const val NAME = "echosoul-sync"

        /** 幂等注册：REPLACE 保证改周期后旧任务被换掉，而不是并存两个。 */
        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<SyncWorker>(
                AppConfig.Realtime.FALLBACK_SYNC_MINUTES,
                TimeUnit.MINUTES,
            )
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

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(NAME)
        }
    }
}
