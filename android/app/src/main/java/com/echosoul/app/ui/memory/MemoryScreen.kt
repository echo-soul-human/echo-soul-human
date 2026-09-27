package com.echosoul.app.ui.memory

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.echosoul.app.ui.design.EchoColors
import com.echosoul.app.ui.design.Space

/** 记忆页：列出 TA 记住的事，逐条可删。 */
@Composable
fun MemoryScreen(
    onBack: () -> Unit,
    vm: MemoryViewModel = hiltViewModel(),
) {
    val memories by vm.memories.collectAsStateWithLifecycle()
    val loading by vm.loading.collectAsStateWithLifecycle()

    Column(Modifier.fillMaxSize().background(EchoColors.current.paper)) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = Space.n3, vertical = Space.n2),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回", tint = EchoColors.current.ink)
            }
            Text("记忆", style = MaterialTheme.typography.titleLarge, color = EchoColors.current.ink)
        }
        HorizontalDivider(color = EchoColors.current.hairline)

        when {
            loading && memories.isEmpty() -> CenterText("正在读取…")
            memories.isEmpty() -> CenterText("还没有记住什么。聊得多了，这里会慢慢长出来。")
            else -> LazyColumn(
                Modifier.fillMaxSize(),
                contentPadding = PaddingValues(vertical = Space.n3),
            ) {
                items(memories, key = { it.id }) { m ->
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = Space.n5, vertical = Space.n4),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Space.n4),
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(
                                m.summary,
                                style = MaterialTheme.typography.bodyLarge,
                                color = EchoColors.current.ink,
                                maxLines = 4,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                "记住于 ${m.createdAt.take(10)}",
                                style = MaterialTheme.typography.bodySmall,
                                color = EchoColors.current.inkFaint,
                            )
                        }
                        TextButton(onClick = { vm.forget(m.id) }) {
                            Icon(Icons.Filled.Delete, contentDescription = "忘记", tint = EchoColors.current.danger)
                        }
                    }
                    HorizontalDivider(Modifier.padding(start = Space.n5), color = EchoColors.current.hairline)
                }
            }
        }
    }
}

@Composable
private fun CenterText(text: String) {
    Box(Modifier.fillMaxSize().padding(Space.n8), contentAlignment = Alignment.Center) {
        Text(text, style = MaterialTheme.typography.bodyMedium, color = EchoColors.current.inkFaint)
    }
}
