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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.echosoul.app.ui.design.EchoColors
import com.echosoul.app.ui.design.Space

/**
 * 角色详情：展示人设（persona / 示例对话 / 行为备注），两个 CTA —— 开始对话、记忆。
 * 详情内容服务端整表返回，客户端只读展示（人设修改入口留待二次迭代，避免半成品编辑页）。
 */
@Composable
fun CharacterDetailScreen(
    characterId: String,
    onStartChat: (String) -> Unit,
    onOpenMemory: () -> Unit,
    onBack: () -> Unit,
    vm: CharacterViewModel = hiltViewModel(),
) {
    val detailMap by vm.detailMap.collectAsStateWithLifecycle()
    val character = detailMap[characterId]

    LaunchedEffect(characterId) { vm.loadDetail(characterId) }

    Column(Modifier.fillMaxSize().background(EchoColors.current.paper)) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = Space.n3, vertical = Space.n2),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回", tint = EchoColors.current.ink)
            }
            Text(
                character?.name ?: "角色",
                style = MaterialTheme.typography.titleLarge,
                color = EchoColors.current.ink,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }

        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(Space.n5),
            verticalArrangement = Arrangement.spacedBy(Space.n4),
        ) {
            character?.tagline?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = MaterialTheme.typography.bodyLarge, color = EchoColors.current.inkSoft)
            }
            Section("设定", character?.personaText.orEmpty())
            Section("行为备注", character?.behaviorNotes.orEmpty())
            if (!character?.exampleDialogs.isNullOrEmpty()) {
                Text("示例对话", style = MaterialTheme.typography.titleMedium, color = EchoColors.current.ink)
                character!!.exampleDialogs.forEach { pair ->
                    pair.forEachIndexed { i, line ->
                        Text(
                            (if (i == 0) "你：" else "TA：") + line,
                            style = MaterialTheme.typography.bodyMedium,
                            color = EchoColors.current.inkSoft,
                        )
                    }
                }
            }
        }

        Row(
            Modifier.fillMaxWidth().padding(Space.n5),
            horizontalArrangement = Arrangement.spacedBy(Space.n4),
        ) {
            CtaButton("记忆", Modifier.weight(1f), secondary = true, onClick = onOpenMemory)
            CtaButton("开始对话", Modifier.weight(1f), secondary = false, onClick = {
                vm.startChat(characterId, onStartChat)
            })
        }
    }
}

@Composable
private fun Section(title: String, body: String) {
    if (body.isBlank()) return
    Column(verticalArrangement = Arrangement.spacedBy(Space.n2)) {
        Text(title, style = MaterialTheme.typography.titleMedium, color = EchoColors.current.ink)
        Text(body, style = MaterialTheme.typography.bodyMedium, color = EchoColors.current.inkSoft)
    }
}

@Composable
private fun CtaButton(text: String, modifier: Modifier, secondary: Boolean, onClick: () -> Unit) {
    Box(
        modifier
            .height(Space.n10)
            .clip(RoundedCornerShape(Space.n5))
            .background(if (secondary) EchoColors.current.paperWarm else EchoColors.current.accent)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text,
            style = MaterialTheme.typography.labelLarge,
            color = if (secondary) EchoColors.current.ink else EchoColors.current.paper,
        )
    }
}
