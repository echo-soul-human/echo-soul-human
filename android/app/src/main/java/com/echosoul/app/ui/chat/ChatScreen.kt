package com.echosoul.app.ui.chat

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.echosoul.app.data.local.CachedMessage
import com.echosoul.app.ui.design.EchoColors
import com.echosoul.app.ui.design.Space

/**
 * 对话界面（P1 核心）。
 *
 * 三条来自分册的硬要求，逐一落在代码里：
 *   1. 流式气泡与落库气泡分开：落库的从 messages，流式中的从 streaming，done 后清空 streaming。
 *   2. 「继续」按钮只在可恢复错误时出现，且复用同一幂等键。
 *   3. 通知权限**首次完成对话后**才申请（shouldAskNotification 触发）。
 */
@Composable
fun ChatScreen(
    sessionId: String,
    onBack: () -> Unit,
    onOpenBilling: () -> Unit,
    onOpenByok: () -> Unit,
    vm: ChatViewModel = hiltViewModel(),
) {
    val messages by vm.messages.collectAsStateWithLifecycle()
    val streaming by vm.streaming.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val error by vm.error.collectAsStateWithLifecycle()
    val shouldAsk by vm.shouldAskNotification.collectAsStateWithLifecycle()
    var input by remember { mutableStateOf("") }

    val listState = rememberLazyListState()
    LaunchedEffect(messages.size, streaming) {
        val target = messages.size + if (streaming.isNotEmpty()) 1 else 0
        if (target > 0) listState.scrollToItem(target - 1)
    }
    LaunchedEffect(Unit) { vm.markRead() }

    // 首次完成对话后申请通知权限（Android 13+）。
    val notifLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { vm.onNotificationPromptShown() }
    LaunchedEffect(shouldAsk) {
        if (shouldAsk && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notifLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else if (shouldAsk) {
            vm.onNotificationPromptShown()
        }
    }

    Column(Modifier.fillMaxSize().background(EchoColors.current.paper)) {
        TopBar(onBack)
        Box(Modifier.weight(1f)) {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(Space.n5),
                verticalArrangement = Arrangement.spacedBy(Space.n3),
            ) {
                items(messages, key = { it.id }) { m -> Bubble(m, streaming = false) }
                if (streaming.isNotEmpty()) {
                    item(key = "streaming") {
                        MessageBubble(content = streaming, fromMe = false, pending = true)
                    }
                }
            }
        }

        error?.let { e ->
            ErrorBar(
                message = e.message,
                recoverable = e.recoverable,
                onContinue = { vm.continueTurn() },
                onDismiss = { vm.consumeError() },
                onBilling = onOpenBilling,
            )
        }

        InputBar(
            value = input,
            busy = busy,
            onValueChange = { input = it; vm.onDraftChange(it) },
            onSend = {
                val text = input.trim()
                if (text.isNotEmpty()) {
                    vm.send(text)
                    input = ""
                }
            },
        )
    }
}

@Composable
private fun TopBar(onBack: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Space.n3, vertical = Space.n2),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回", tint = EchoColors.current.ink)
        }
        Text(
            "对话",
            style = MaterialTheme.typography.titleLarge,
            color = EchoColors.current.ink,
        )
    }
}

@Composable
private fun Bubble(m: CachedMessage, streaming: Boolean) {
    MessageBubble(content = m.content, fromMe = m.role == "user", pending = streaming || m.partial)
}

/**
 * 气泡。用户消息靠右、蓝底；角色消息靠左、纸底描边。
 * 不做 Markdown 富文本（一期正文是纯文本；Markdown 渲染放后续，避免引入解析库与注入面）。
 */
@Composable
private fun MessageBubble(content: String, fromMe: Boolean, pending: Boolean) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = if (fromMe) Arrangement.End else Arrangement.Start,
    ) {
        Box(
            Modifier
                .widthIn(max = Space.n16 * 4)
                .clip(RoundedCornerShape(Space.n5))
                .background(if (fromMe) EchoColors.current.accent else EchoColors.current.paperWarm)
                .padding(horizontal = Space.n4, vertical = Space.n3),
        ) {
            Text(
                content.ifEmpty { if (pending) "…" else "" },
                style = MaterialTheme.typography.bodyLarge,
                color = if (fromMe) EchoColors.current.paper else EchoColors.current.ink,
            )
        }
    }
}

@Composable
private fun ErrorBar(
    message: String,
    recoverable: Boolean,
    onContinue: () -> Unit,
    onDismiss: () -> Unit,
    onBilling: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth()
            .background(EchoColors.current.pinkTint)
            .padding(horizontal = Space.n4, vertical = Space.n3),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            message,
            style = MaterialTheme.typography.bodyMedium,
            color = EchoColors.current.pinkInk,
            modifier = Modifier.weight(1f),
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        if (recoverable) {
            TextButton(onClick = onContinue) { Text("继续") }
        }
        if (!recoverable) {
            TextButton(onClick = onBilling) { Text("去续费") }
        }
        TextButton(onClick = onDismiss) { Text("知道了") }
    }
}

@Composable
private fun InputBar(
    value: String,
    busy: Boolean,
    onValueChange: (String) -> Unit,
    onSend: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().padding(Space.n4),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.n3),
    ) {
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier.weight(1f),
            placeholder = { Text("想说什么就说") },
            maxLines = 5,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { onSend() }),
            shape = RoundedCornerShape(Space.n5),
        )
        IconButton(onClick = onSend, enabled = !busy && value.isNotBlank()) {
            if (busy) {
                CircularProgressIndicator(Modifier.size(Space.n6), strokeWidth = Space.n1)
            } else {
                Icon(
                    Icons.AutoMirrored.Filled.Send,
                    contentDescription = "发送",
                    tint = if (value.isNotBlank()) EchoColors.current.accent else EchoColors.current.inkFaint,
                )
            }
        }
    }
}
