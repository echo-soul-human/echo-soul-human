package com.echosoul.app.update

import com.echosoul.app.data.model.AndroidVersion

/**
 * 更新链路的 UI 状态机。UI（设置页 / 弹层）只读这一个 StateFlow，不自己拼状态。
 */
sealed interface UpdateUiState {
    /** 没有可用更新，或还没检查。 */
    data object Idle : UpdateUiState

    /** 发现新版本，等待用户选择「稍后 / 立即」。 */
    data class Available(val version: AndroidVersion, val forced: Boolean) : UpdateUiState

    /** 正在下载。percent 0-100，bytesTotal 可能为 0（服务端未给 Content-Length）。 */
    data class Downloading(val downloadId: Long, val percent: Int, val bytesTotal: Long) : UpdateUiState

    /** 校验通过、准备安装。 */
    data class Ready(val version: AndroidVersion) : UpdateUiState

    /** 需要「安装未知应用」权限，等待用户去系统设置授予。 */
    data object NeedInstallPermission : UpdateUiState

    /** 用户取消下载（包保留，下次可直接校验）。 */
    data object Canceled : UpdateUiState

    /** 失败；reason 决定提示文案与是否降级浏览器。 */
    data class Failed(val reason: UpdateManager.Reason) : UpdateUiState
}
