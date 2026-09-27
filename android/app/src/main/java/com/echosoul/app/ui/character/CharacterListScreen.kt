package com.echosoul.app.ui.character

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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
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
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.echosoul.app.data.model.CharacterRow
import com.echosoul.app.ui.design.EchoColors
import com.echosoul.app.ui.design.Space

/** 角色列表。点进详情，右上角新建。 */
@Composable
fun CharacterListScreen(
    onOpen: (String) -> Unit,
    onCreate: () -> Unit,
    onBack: () -> Unit,
    vm: CharacterViewModel = hiltViewModel(),
) {
    val characters by vm.characters.collectAsStateWithLifecycle()

    Column(Modifier.fillMaxSize().background(EchoColors.current.paper)) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = Space.n3, vertical = Space.n2),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回", tint = EchoColors.current.ink)
            }
            Text(
                "角色",
                style = MaterialTheme.typography.titleLarge,
                color = EchoColors.current.ink,
                modifier = Modifier.weight(1f),
            )
            IconButton(onClick = onCreate) {
                Icon(Icons.Filled.Add, contentDescription = "新建角色", tint = EchoColors.current.accent)
            }
        }
        HorizontalDivider(color = EchoColors.current.hairline)

        if (characters.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("还没有角色。", color = EchoColors.current.inkFaint)
            }
        } else {
            LazyColumn(Modifier.fillMaxSize()) {
                items(characters, key = { it.id }) { c ->
                    CharacterItem(c) { onOpen(c.id) }
                    HorizontalDivider(Modifier.padding(start = Space.n5), color = EchoColors.current.hairline)
                }
            }
        }
    }
}

@Composable
private fun CharacterItem(c: CharacterRow, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(Space.n5),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.n4),
    ) {
        Box(Modifier.size(Space.n12).clip(CircleShape).background(EchoColors.current.pinkTint))
        Column(Modifier.weight(1f)) {
            Text(
                c.name,
                style = MaterialTheme.typography.titleMedium,
                color = EchoColors.current.ink,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                c.tagline.ifBlank { c.greeting },
                style = MaterialTheme.typography.bodyMedium,
                color = EchoColors.current.inkFaint,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
