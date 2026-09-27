package com.echosoul.app.ui.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.echosoul.app.ui.design.EchoColors
import com.echosoul.app.ui.design.Space

/**
 * 进入门。
 *
 * ★ 主 CTA 是「先聊聊」（匿名）：降低首次门槛，不用注册/填 Key。
 *   邮箱验证码作为第二条路，展开后才有输入框，避免一上来就是表单。
 */
@Composable
fun AuthScreen(
    onSignedIn: () -> Unit,
    vm: AuthViewModel = hiltViewModel(),
) {
    val busy by vm.busy.collectAsStateWithLifecycle()
    val error by vm.error.collectAsStateWithLifecycle()
    val codeSentTo by vm.codeSentTo.collectAsStateWithLifecycle()

    var email by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var emailExpanded by remember { mutableStateOf(false) }

    Column(
        Modifier.fillMaxSize().background(EchoColors.current.paper).padding(Space.n8),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("星回", style = MaterialTheme.typography.displaySmall, color = EchoColors.current.ink)
        Text(
            "有人回应的，才叫爱",
            style = MaterialTheme.typography.bodyLarge,
            color = EchoColors.current.inkFaint,
            modifier = Modifier.padding(top = Space.n3, bottom = Space.n10),
        )

        if (!vm.configured) {
            // 缺配不是用户的问题，也不是崩溃：明确说这是构建配置缺失。
            Text(
                "还没配上服务地址。这是构建配置缺失，不是你的问题。",
                style = MaterialTheme.typography.bodyMedium,
                color = EchoColors.current.danger,
            )
            return@Column
        }

        CtaButton("先聊聊", primary = true, enabled = !busy) {
            vm.signInAnonymously(onSignedIn)
        }
        Text(
            "不用注册，不用填任何 Key。聊上几句再决定要不要留下。",
            style = MaterialTheme.typography.bodySmall,
            color = EchoColors.current.inkFaint,
            modifier = Modifier.padding(top = Space.n3),
        )

        if (!emailExpanded) {
            TextButton(onClick = { emailExpanded = true }) { Text("用邮箱登录") }
        } else {
            Column(
                Modifier.fillMaxWidth().padding(top = Space.n6),
                verticalArrangement = Arrangement.spacedBy(Space.n3),
            ) {
                OutlinedTextField(
                    value = email,
                    onValueChange = { email = it },
                    label = { Text("邮箱") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    shape = RoundedCornerShape(Space.n4),
                )
                CtaButton("发验证码", primary = false, enabled = !busy) { vm.sendCode(email) }

                codeSentTo?.let { e ->
                    Text(
                        "验证码已发出，去 $e 收一下，回来这个页面会自动登录。",
                        style = MaterialTheme.typography.bodySmall,
                        color = EchoColors.current.inkFaint,
                    )
                    OutlinedTextField(
                        value = code,
                        onValueChange = { code = it },
                        label = { Text("验证码") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        shape = RoundedCornerShape(Space.n4),
                    )
                    CtaButton("登录", primary = true, enabled = !busy) {
                        vm.verifyCode(e, code, onSignedIn)
                    }
                }
            }
        }

        error?.let {
            Row(Modifier.padding(top = Space.n5), verticalAlignment = Alignment.CenterVertically) {
                Text(it, style = MaterialTheme.typography.bodyMedium, color = EchoColors.current.danger)
                TextButton(onClick = { vm.consumeError() }) { Text("知道了") }
            }
        }
    }
}

@Composable
private fun CtaButton(label: String, primary: Boolean, enabled: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.fillMaxWidth().height(Space.n10)
            .clip(RoundedCornerShape(Space.n5))
            .background(
                when {
                    !enabled -> EchoColors.current.hairline
                    primary -> EchoColors.current.accent
                    else -> EchoColors.current.paperWarm
                },
            )
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelLarge,
            color = if (primary) EchoColors.current.paper else EchoColors.current.ink,
        )
    }
}
