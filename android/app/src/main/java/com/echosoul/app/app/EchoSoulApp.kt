package com.echosoul.app.app

import android.app.ActivityManager
import android.content.Context
import android.os.StrictMode
import androidx.hilt.work.HiltWorkerFactory
import androidx.work.Configuration
import com.echosoul.app.BuildConfig
import com.echosoul.app.diagnostic.Diagnostics
import com.echosoul.app.realtime.SyncWorker
import com.echosoul.app.update.UpdateCheckWorker
import dagger.hilt.android.HiltAndroidApp
import javax.inject.Inject

/**
 * Application 入口。
 *
 * ★ 冷启动预算是 ≤1.5s（P0），所以这里**绝不做网络或磁盘 IO**：
 *   - 不在这里初始化崩溃上报/数据/网络（那全是懒加载，由 Hilt 单例按需构造）；
 *   - 通知渠道的创建放在前台服务启动时（Notifier.ensureChannels），不占启动路径；
 *   - WorkManager 的周期任务注册放这里，但它是 in-memory 入队，不做 IO 的同步等待。
 *
 * ★ 低端机降级：读 ActivityManager.isLowRamDevice 是**同步且极轻**的系统调用（读一个 flag），
 *   可以在这里做；据此关纹理与动效（供 Theme 与图片层读取）。
 *
 * ★ 不做互拉/守护/开机自启：WorkManager 会在重启后自行恢复周期任务，
 *   因此 manifest 有意不声明 RECEIVE_BOOT_COMPLETED。
 */
@HiltAndroidApp
class EchoSoulApp : android.app.Application(), Configuration.Provider {

    @Inject lateinit var workerFactory: HiltWorkerFactory
    @Inject lateinit var diagnostics: Diagnostics

    /** 低端机标记：Theme 与 Coil 层据此关纹理/动效，保证不卡。 */
    var lowRamDevice: Boolean = false
        private set

    override fun onCreate() {
        super.onCreate()

        lowRamDevice = runCatching {
            (getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).isLowRamDevice
        }.getOrDefault(false)
        diagnostics.lowRamDevice = lowRamDevice

        if (BuildConfig.DEBUG) installStrictMode()

        // 诊断只在显式场景落盘，不在这里写文件（避免冷启动 IO）。
        diagnostics.info("app", "start v${BuildConfig.VERSION_NAME}(${BuildConfig.VERSION_CODE}) lowRam=$lowRamDevice")

        // WorkManager 兜底：消息补拉 + 更新检查。in-memory 入队，不阻塞首帧。
        SyncWorker.schedule(this)
        UpdateCheckWorker.schedule(this)
    }

    /**
     * WorkManager 用 Hilt 的 WorkerFactory（@HiltWorker 的 Worker 靠它注入依赖）。
     * 配合 manifest 里移除默认 InitializationProvider，冷启动少做一遍无谓初始化。
     */
    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder()
            .setWorkerFactory(workerFactory)
            .setMinimumLoggingLevel(if (BuildConfig.DEBUG) android.util.Log.DEBUG else android.util.Log.WARN)
            .build()

    /** 仅 debug：主线程磁盘/网络访问立刻报错，把"顺手 IO"挡在开发期。 */
    private fun installStrictMode() {
        StrictMode.setThreadPolicy(
            StrictMode.ThreadPolicy.Builder()
                .detectDiskReads()
                .detectDiskWrites()
                .detectNetwork()
                .penaltyLog()
                .build(),
        )
        StrictMode.setVmPolicy(
            StrictMode.VmPolicy.Builder()
                .detectLeakedClosableObjects()
                .penaltyLog()
                .build(),
        )
    }
}
