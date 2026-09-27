package com.echosoul.app.ui.navigation

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.hilt.navigation.compose.hiltViewModel
import com.echosoul.app.data.local.SessionRow
import com.echosoul.app.ui.chat.SessionListViewModel
import com.echosoul.app.ui.design.EchoColors
import com.echosoul.app.ui.design.Space

/**
 * 会话列表路由（底部导航的「聊天」页）。
 *
 * 数据来自 SessionRepository.sessions（本地缓存 Flow），进页面触发一次后台刷新。
 * 服务端 list_sessions() 已算好排序/未读/预览，这里只画。
 */
@Composable
fun ChatSessionListRoute(
    onOpenSession: (String) -> Unit,
    onNewCharacter: () -> Unit,
    onOpenCharacters: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenBilling: () -> Unit,
    vm: SessionListViewModel = hiltViewModel(),
) {
    val sessions by vm.sessions.collectAsStateWithLifecycle()

    Column(Modifier.fillMaxSize().background(EchoColors.current.paper)) {
        Row(
            Modifier.fillMaxWidth().padding(Space.n5),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "聊天",
                style = MaterialTheme.typography.headlineSmall,
                color = EchoColors.current.ink,
                modifier = Modifier.weight(1f),
            )
            IconButton(onClick = onNewCharacter) {
                Icon(Icons.Filled.Add, contentDescription = "新建角色", tint = EchoColors.current.accent)
            }
            IconButton(onClick = onOpenSettings) {
                Icon(Icons.Filled.Settings, contentDescription = "设置", tint = EchoColors.current.inkSoft)
            }
        }
        HorizontalDivider(color = EchoColors.current.hairline)

        if (sessions.isEmpty()) {
            EmptySessions(onNewCharacter)
        } else {
            LazyColumn(Modifier.fillMaxSize()) {
                items(sessions, key = { it.id }) { row ->
                    SessionItem(row, onClick = { onOpenSession(row.id) })
                    HorizontalDivider(
                        Modifier.padding(start = Space.n5),
                        color = EchoColors.current.hairline,
                    )
                }
            }
        }
    }
}

@Composable
private fun SessionItem(row: SessionRow, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(Space.n5),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.n4),
    ) {
        Box(
            Modifier.size(Space.n10).clip(CircleShape).background(EchoColors.current.accentTint),
        )
        Column(Modifier.weight(1f)) {
            Text(
                row.title ?: row.characterNames.firstOrNull() ?: "新的对话",
                style = MaterialTheme.typography.titleMedium,
                color = EchoColors.current.ink,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            row.preview?.let { p ->
                Text(
                    p,
                    style = MaterialTheme.typography.bodyMedium,
                    color = EchoColors.current.inkFaint,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (row.unread > 0) {
            Box(
                Modifier.clip(RoundedCornerShape(Space.n3))
                    .background(EchoColors.current.pinkDeep)
                    .padding(horizontal = Space.n3, vertical = Space.n1),
            ) {
                Text("${row.unread}", style = MaterialTheme.typography.labelSmall, color = EchoColors.current.paper)
            }
        }
    }
}

@Composable
private fun EmptySessions(onNewCharacter: () -> Unit) {
    Column(
        Modifier.fillMaxSize().padding(Space.n8),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text("还没有对话", style = MaterialTheme.typography.titleLarge, color = EchoColors.current.ink)
        Text(
            "选一个角色，或者三句话建一个。",
            style = MaterialTheme.typography.bodyMedium,
            color = EchoColors.current.inkFaint,
            modifier = Modifier.padding(top = Space.n3),
        )
        Box(
            Modifier.padding(top = Space.n6).clip(RoundedCornerShape(Space.n5))
                .background(EchoColors.current.accent)
                .clickable(onClick = onNewCharacter)
                .padding(horizontal = Space.n6, vertical = Space.n4),
        ) {
            Text("新建角色", color = EchoColors.current.paper, style = MaterialTheme.typography.labelLarge)
        }
    }
}
