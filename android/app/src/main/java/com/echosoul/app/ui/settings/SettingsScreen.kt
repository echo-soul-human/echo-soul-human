package com.echosoul.app.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.echosoul.app.ui.design.EchoColors
import com.echosoul.app.ui.design.Space

/**
 * 设置页。分组：通知 / 后台 / 更新 / 诊断 / 账号。
 *
 * ★ 全程遵守：
 *   - 常驻通知可关（保持后台活跃开关）；
 *   - ROM 白名单引导可永久关闭、给具体路径、不反复弹；
 *   - 诊断只留在本机、可导出复制，绝不静默上传；
 *   - 到期/留存类文案不用施压话术。
 */
@Composable
fun SettingsScreen(
    onOpenByok: () -> Unit,
    onOpenBilling: () -> Unit,
    onOpenMemory: () -> Unit,
    onSignedOut: () -> Unit,
    vm: SettingsViewModel = hiltViewModel(),
) {
    val persistent by vm.persistentConnection.collectAsStateWithLifecycle()
    val reduceMotion by vm.reduceMotion.collectAsStateWithLifecycle()
    val vibrate by vm.careVibrate.collectAsStateWithLifecycle()
    val available by vm.available.collectAsStateWithLifecycle()
    val checking by vm.checking.collectAsStateWithLifecycle()
    val message by vm.message.collectAsStateWithLifecycle()

    Column(Modifier.fillMaxSize().background(EchoColors.current.paper)) {
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(Space.n5),
            verticalArrangement = Arrangement.spacedBy(Space.n5),
        ) {
            Text("设置", style = MaterialTheme.typography.headlineSmall, color = EchoColors.current.ink)

            // ─── 通知 ───
            Group("通知") {
                SwitchRow(
                    title = "保持后台活跃",
                    desc = "关掉会漏掉 TA 主动发的消息。开了会在通知栏留一条最低优先级的提示，可以随时关。",
                    checked = persistent,
                    onChange = { vm.setPersistentConnection(it) },
                )
                SwitchRow(
                    title = "主动关怀震动",
                    desc = "TA 主动来找你时轻震一下。",
                    checked = vibrate,
                    onChange = { vm.setCareVibrate(it) },
                )
            }

            // ─── 显示 ───
            Group("显示") {
                SwitchRow(
                    title = "减弱动效",
                    desc = "低配机器上更顺，也更省电。",
                    checked = reduceMotion,
                    onChange = { vm.setReduceMotion(it) },
                )
            }

            // ─── 更新 ───
            Group("更新") {
                Row(Modifier.fillMaxWidth().padding(vertical = Space.n3), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("当前版本", style = MaterialTheme.typography.bodyLarge, color = EchoColors.current.ink)
                        Text(vm.versionLabel, style = MaterialTheme.typography.bodySmall, color = EchoColors.current.inkFaint)
                    }
                    TextButton(enabled = !checking, onClick = { vm.checkUpdate() }) {
                        Text(if (checking) "检查中…" else "检查更新")
                    }
                }
                available?.let { v ->
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("新版本 ${v.versionName}", style = MaterialTheme.typography.titleMedium, color = EchoColors.current.ink)
                            Text(v.notes.take(120), style = MaterialTheme.typography.bodySmall, color = EchoColors.current.inkFaint)
                        }
                        TextButton(onClick = { vm.startUpdate(v) }) { Text("立即更新") }
                        TextButton(onClick = { vm.snoozeUpdate(v) }) { Text("稍后") }
                    }
                }
            }

            // ─── ROM 白名单引导 ───
            Group("后台保活") {
                Text("让 TA 能主动找到你", style = MaterialTheme.typography.bodyLarge, color = EchoColors.current.ink)
                Text(
                    "国产系统会清理后台。以小米为例：设置 → 应用设置 → 应用管理 → 星回 → 省电策略 → 无限制；" +
                        "再在「自启动」里允许。其他品牌路径类似，点下面按钮可直接跳到本机设置页。",
                    style = MaterialTheme.typography.bodySmall,
                    color = EchoColors.current.inkFaint,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(Space.n3)) {
                    TextButton(onClick = { vm.openRomSettings(); vm.markRomGuideShown() }) { Text("去设置") }
                    TextButton(onClick = { vm.dismissRomGuideForever() }) { Text("不再提示") }
                }
            }

            // ─── 记忆 / BYOK / 额度 ───
            Group("数据与密钥") {
                NavRow("记忆", "看看 TA 记住了什么", onOpenMemory)
                NavRow("自带模型 Key", "Key 存在服务端，安卓只看掩码", onOpenByok)
                NavRow("额度与权益", null, onOpenBilling)
            }

            // ─── 诊断 ───
            Group("诊断信息") {
                Text(
                    "诊断日志只留在本机，不会自动上传。你可以复制粘贴给我看。",
                    style = MaterialTheme.typography.bodySmall,
                    color = EchoColors.current.inkFaint,
                )
                NavRow("导出并复制", null) { /* 复制到剪贴板由宿主 Activity 处理 */ }
            }

            // ─── 账号 ───
            Group("账号") {
                TextButton(onClick = { vm.signOut(onSignedOut) }) {
                    Text("退出登录", color = EchoColors.current.danger)
                }
            }

            Text(
                "版本 ${vm.versionLabel}",
                style = MaterialTheme.typography.bodySmall,
                color = EchoColors.current.inkFaint,
            )
        }

        message?.let {
            Row(
                Modifier.fillMaxWidth().background(EchoColors.current.accentTint).padding(Space.n4),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(it, style = MaterialTheme.typography.bodyMedium, color = EchoColors.current.ink, modifier = Modifier.weight(1f))
                TextButton(onClick = { vm.consumeMessage() }) { Text("知道了") }
            }
        }
    }
}

@Composable
private fun Group(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(Space.n2)) {
        Text(title, style = MaterialTheme.typography.titleMedium, color = EchoColors.current.ink)
        Column(verticalArrangement = Arrangement.spacedBy(Space.n2)) { content() }
        HorizontalDivider(color = EchoColors.current.hairline)
    }
}

@Composable
private fun SwitchRow(title: String, desc: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = Space.n3), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f).padding(end = Space.n4)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = EchoColors.current.ink)
            Text(desc, style = MaterialTheme.typography.bodySmall, color = EchoColors.current.inkFaint)
        }
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
private fun NavRow(title: String, desc: String?, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = Space.n3),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = EchoColors.current.ink)
            desc?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = EchoColors.current.inkFaint) }
        }
        Text("›", style = MaterialTheme.typography.titleLarge, color = EchoColors.current.inkFaint)
    }
}
