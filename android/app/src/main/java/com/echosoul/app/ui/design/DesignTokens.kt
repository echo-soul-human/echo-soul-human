/** 由 scripts/gen-tokens.mjs 生成 —— 禁止手工编辑 */
package com.echosoul.app.ui.design

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

object Ink {
    val paper: Color(0xFFFBF8F6u)
    val paper_warm: Color(0xFFF4EDE8u)
    val paper_deep: Color(0xFFE9DFD8u)
    val blue: Color(0xFF7FB6D9u)
    val blue_deep: Color(0xFF4E88AEu)
    val blue_press: Color(0xFF3E6F92u)
    val blue_tint: Color(0xFFE8F1F8u)
    val blue_ink: Color(0xFF22333Du)
    val pink: Color(0xFFF2A9B8u)
    val pink_deep: Color(0xFFE0829Au)
    val pink_tint: Color(0xFFFADDE3u)
    val pink_ink: Color(0xFF4A2C33u)
    val ink: Color(0xFF2B2622u)
    val ink_soft: Color(0xFF5C5347u)
    val ink_faint: Color(0xFF8C8172u)
    val hairline: Color(0xFFE3D8D0u)
    val hairline_strong: Color(0xFFC4B3A8u)
    val accent: Color(0xFF4E88AEu)
    val accent_deep: Color(0xFF3E6F92u)
    val danger: Color(0xFFA8321Eu)
    val warn: Color(0xFFC9862Bu)
    val ok: Color(0xFF4A7A56u)
}

object Space {
    val n0: 0.dp
    val n1: 2.dp
    val n2: 4.dp
    val n3: 8.dp
    val n4: 12.dp
    val n5: 16.dp
    val n6: 20.dp
    val n7: 24.dp
    val n8: 32.dp
    val n9: 40.dp
    val n10: 48.dp
    val n12: 64.dp
    val n16: 96.dp
}

/** 禁用 Material You 动态取色：跟随壁纸会毁掉品牌视觉一致性 */
const val USE_DYNAMIC_COLOR = false;
