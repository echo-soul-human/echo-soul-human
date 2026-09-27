package com.echosoul.app.ui.billing

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.echosoul.app.ui.design.EchoColors
import com.echosoul.app.ui.design.Space

/**
 * 额度与权益页。
 *
 * ★ 文案红线（D1 定案，写死在展示层）：
 *   - 有效期只出现「31 天 / 372 天」，**不出现「月」「自动续费」**。
 *   - 到期相关只用中性描述（"有效期至 X"），不使用施压话术。
 */
@Composable
fun BillingScreen(
    onBack: () -> Unit,
    vm: BillingViewModel = hiltViewModel(),
) {
    val credit by vm.credit.collectAsStateWithLifecycle()

    Column(Modifier.fillMaxSize().background(EchoColors.current.paper)) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = Space.n3, vertical = Space.n2),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回", tint = EchoColors.current.ink)
            }
            Text("额度与权益", style = MaterialTheme.typography.titleLarge, color = EchoColors.current.ink)
        }
        HorizontalDivider(color = EchoColors.current.hairline)

        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(Space.n5),
            verticalArrangement = Arrangement.spacedBy(Space.n5),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(Space.n5)) {
                Stat("可用余额", "¥${vm.money(credit?.usable ?: 0.0)}", primary = true)
                Stat("占用中", "¥${vm.money(credit?.frozen ?: 0.0)}", primary = false)
            }

            Card {
                Line("当前档位", vm.tierName(credit?.tier ?: "free"))
                credit?.expiresAt?.let { Line("有效期至", it.take(10)) }
                credit?.ttsRemaining?.let { Line("语音剩余", vm.money(it)) }
            }

            Text("档位", style = MaterialTheme.typography.titleMedium, color = EchoColors.current.ink)
            Card {
                // 有效期文案只有一个合法写法：31 天 / 372 天。
                Line("支持档 · 31 天", "¥19")
                Divider()
                Line("长情档 · 372 天", "¥168")
            }

            Text("怎么到账", style = MaterialTheme.typography.titleMedium, color = EchoColors.current.ink)
            Text(
                "在爱发电下单后用同一个邮箱，系统会自动对上并到账，不需要兑换码、不用联系客服。",
                style = MaterialTheme.typography.bodyMedium,
                color = EchoColors.current.inkSoft,
            )
        }
    }
}

@Composable
private fun Stat(label: String, value: String, primary: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(Space.n2)) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = EchoColors.current.inkFaint)
        Text(
            value,
            style = if (primary) MaterialTheme.typography.headlineSmall else MaterialTheme.typography.titleLarge,
            color = if (primary) EchoColors.current.accentDeep else EchoColors.current.inkSoft,
        )
    }
}

@Composable
private fun Card(content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Space.n4))
            .background(EchoColors.current.paperWarm).padding(Space.n4),
        verticalArrangement = Arrangement.spacedBy(Space.n3),
    ) { content() }
}

@Composable
private fun Line(left: String, right: String) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(left, style = MaterialTheme.typography.bodyLarge, color = EchoColors.current.ink, modifier = Modifier.weight(1f))
        Text(right, style = MaterialTheme.typography.bodyLarge, color = EchoColors.current.inkSoft)
    }
}

@Composable
private fun Divider() = HorizontalDivider(color = EchoColors.current.hairline)
