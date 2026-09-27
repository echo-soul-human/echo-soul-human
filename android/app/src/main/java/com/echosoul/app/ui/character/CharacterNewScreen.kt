package com.echosoul.app.ui.character

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
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
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
 * 三句话建角色（wizard）。
 *
 * ★ "三句话"的产品含义：名字 + 一句话人设 + 一句开场白，就足够开始。
 *   示例对话是可选加强项（定人设靠示例而非形容词，见 002 表注释），不强制填。
 * ★ 所有字段原样递服务端，本地不做内容校验（词违规判定在服务端，客户端不重复实现）。
 */
@Composable
fun CharacterNewScreen(
    onCreated: (String) -> Unit,
    onBack: () -> Unit,
    vm: CharacterViewModel = hiltViewModel(),
) {
    var name by remember { mutableStateOf("") }
    var tagline by remember { mutableStateOf("") }
    var persona by remember { mutableStateOf("") }
    var greeting by remember { mutableStateOf("") }
    val creating by vm.creating.collectAsStateWithLifecycle()
    val error by vm.error.collectAsStateWithLifecycle()

    Column(Modifier.fillMaxSize().background(EchoColors.current.paper)) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = Space.n3, vertical = Space.n2),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回", tint = EchoColors.current.ink)
            }
            Text("新建角色", style = MaterialTheme.typography.titleLarge, color = EchoColors.current.ink)
        }

        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(Space.n5),
            verticalArrangement = Arrangement.spacedBy(Space.n4),
        ) {
            Text("三句话建一个角色", style = MaterialTheme.typography.titleMedium, color = EchoColors.current.ink)
            Field("TA 的名字", name) { name = it }
            Field("一句话是什么样的 TA", tagline) { tagline = it }
            Field("TA 是什么样的人（可选）", persona, minLines = 3) { persona = it }
            Field("TA 见到你说的第一句（可选）", greeting) { greeting = it }

            error?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium, color = EchoColors.current.danger)
            }
        }

        Box(
            Modifier.fillMaxWidth().padding(Space.n5)
                .height(Space.n10)
                .clip(RoundedCornerShape(Space.n5))
                .background(if (creating || name.isBlank()) EchoColors.current.hairline else EchoColors.current.accent)
                .clickable(enabled = !creating && name.isNotBlank()) {
                    vm.create(
                        name = name,
                        tagline = tagline,
                        persona = persona,
                        greeting = greeting,
                        examples = emptyList(),
                        onCreated = onCreated,
                    )
                },
            contentAlignment = Alignment.Center,
        ) {
            Text(
                if (creating) "正在建…" else "建好了",
                style = MaterialTheme.typography.labelLarge,
                color = EchoColors.current.paper,
            )
        }
    }
}

@Composable
private fun Field(
    label: String,
    value: String,
    minLines: Int = 1,
    onChange: (String) -> Unit,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label) },
        modifier = Modifier.fillMaxWidth(),
        minLines = minLines,
        shape = RoundedCornerShape(Space.n4),
    )
}
