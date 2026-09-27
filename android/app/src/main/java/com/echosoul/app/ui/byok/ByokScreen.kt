package com.echosoul.app.ui.byok

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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.echosoul.app.ui.design.EchoColors
import com.echosoul.app.ui.design.Space

/**
 * BYOK 页（E5/G1 定案）。
 *
 * ★ 页面上的 Key 输入框是**一次性**的：提交后立即清空；已保存的配置只显示掩码（key_mask）。
 *   "这里看不到明文，也不需要重填"是刻意设计，不是功能缺失。
 * ★ 文案明确"请求经服务器中转"（chat_relay_notice），用户知道 Key 不直连厂商。
 */
@Composable
fun ByokScreen(
    onBack: () -> Unit,
    vm: ByokViewModel = hiltViewModel(),
) {
    val profiles by vm.profiles.collectAsStateWithLifecycle()
    val saving by vm.saving.collectAsStateWithLifecycle()
    val message by vm.message.collectAsStateWithLifecycle()

    var kind by remember { mutableStateOf("openai") }
    var label by remember { mutableStateOf("") }
    var baseUrl by remember { mutableStateOf("") }
    var model by remember { mutableStateOf("") }
    var apiKey by remember { mutableStateOf("") }

    Column(Modifier.fillMaxSize().background(EchoColors.current.paper)) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = Space.n3, vertical = Space.n2),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回", tint = EchoColors.current.ink)
            }
            Text("自带模型 Key", style = MaterialTheme.typography.titleLarge, color = EchoColors.current.ink)
        }
        HorizontalDivider(color = EchoColors.current.hairline)

        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(Space.n5),
            verticalArrangement = Arrangement.spacedBy(Space.n4),
        ) {
            Text(
                "把你自己的 Key 存在服务端加密保管，安卓这边只看得到掩码，也导不出来。",
                style = MaterialTheme.typography.bodyMedium,
                color = EchoColors.current.inkFaint,
            )
            Text(
                "为保护你的密钥，请求经服务器中转。",
                style = MaterialTheme.typography.bodySmall,
                color = EchoColors.current.inkFaint,
            )

            if (profiles.isNotEmpty()) {
                Text("已保存", style = MaterialTheme.typography.titleMedium, color = EchoColors.current.ink)
                profiles.forEach { p ->
                    Column(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(Space.n4))
                            .background(EchoColors.current.paperWarm).padding(Space.n4),
                        verticalArrangement = Arrangement.spacedBy(Space.n2),
                    ) {
                        Text(
                            p.label.ifBlank { p.model },
                            style = MaterialTheme.typography.titleMedium,
                            color = EchoColors.current.ink,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            "已保存（掩码 ${p.keyMask}）。这里看不到明文，也不需要重填。",
                            style = MaterialTheme.typography.bodySmall,
                            color = EchoColors.current.inkFaint,
                        )
                        TextButton(onClick = { vm.delete(p.id) }) {
                            Text("删掉这个配置", color = EchoColors.current.danger)
                        }
                    }
                }
            }

            HorizontalDivider(color = EchoColors.current.hairline)
            Text("添加配置", style = MaterialTheme.typography.titleMedium, color = EchoColors.current.ink)

            Row(horizontalArrangement = Arrangement.spacedBy(Space.n3)) {
                KindChip("OpenAI 兼容", kind == "openai") { kind = "openai" }
                KindChip("Anthropic", kind == "anthropic") { kind = "anthropic" }
            }
            Field("起个名字", label) { label = it }
            Field("接口地址", baseUrl) { baseUrl = it }
            Field("模型名", model) { model = it }
            OutlinedTextField(
                value = apiKey,
                onValueChange = { apiKey = it },
                label = { Text("API Key") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                shape = RoundedCornerShape(Space.n4),
            )

            message?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = EchoColors.current.inkSoft) }

            Box(
                Modifier.fillMaxWidth().height(Space.n10)
                    .clip(RoundedCornerShape(Space.n5))
                    .background(if (saving) EchoColors.current.hairline else EchoColors.current.accent)
                    .clickable(enabled = !saving) {
                        vm.save(kind, label, baseUrl, model, apiKey) {
                            // 提交后立刻清空：明文不在 UI 里多留一秒。
                            apiKey = ""
                        }
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text("保存", style = MaterialTheme.typography.labelLarge, color = EchoColors.current.paper)
            }
        }
    }
}

@Composable
private fun KindChip(text: String, selected: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.clip(RoundedCornerShape(Space.n4))
            .background(if (selected) EchoColors.current.accentTint else EchoColors.current.paperWarm)
            .clickable(onClick = onClick)
            .padding(horizontal = Space.n4, vertical = Space.n3),
    ) {
        Text(text, style = MaterialTheme.typography.labelLarge, color = EchoColors.current.ink)
    }
}

@Composable
private fun Field(label: String, value: String, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label) },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
        shape = RoundedCornerShape(Space.n4),
    )
}
