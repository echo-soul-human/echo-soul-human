package com.echosoul.app.ui.design

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * 主题：**基于 DesignTokens 自建 ColorScheme/Typography**，绝不用 Material You 动态取色。
 *
 * ★ 为什么禁用动态取色（USE_DYNAMIC_COLOR=false）：
 *   Material You 跟随壁纸会毁掉品牌视觉一致性 —— 同一个 App 在两台机上两种色，
 *   截图、物料、客服话术全对不上。设计 token 是唯一色源。
 *
 * 亮色是主场景（"纸"的质感）；暗色只把纸色压深、墨色提亮，蓝/粉强调色保持一致，
 * 保证品牌色在任何模式下都可辨认。
 */

/** 品牌强调色等 token 之外、但 UI 反复要用的语义色，走 CompositionLocal 而不是硬编码。 */
data class EchoSoulColors(
    val paper: androidx.compose.ui.graphics.Color,
    val paperWarm: androidx.compose.ui.graphics.Color,
    val paperDeep: androidx.compose.ui.graphics.Color,
    val ink: androidx.compose.ui.graphics.Color,
    val inkSoft: androidx.compose.ui.graphics.Color,
    val inkFaint: androidx.compose.ui.graphics.Color,
    val hairline: androidx.compose.ui.graphics.Color,
    val hairlineStrong: androidx.compose.ui.graphics.Color,
    val accent: androidx.compose.ui.graphics.Color,
    val accentDeep: androidx.compose.ui.graphics.Color,
    val accentPress: androidx.compose.ui.graphics.Color,
    val accentTint: androidx.compose.ui.graphics.Color,
    val pink: androidx.compose.ui.graphics.Color,
    val pinkDeep: androidx.compose.ui.graphics.Color,
    val pinkTint: androidx.compose.ui.graphics.Color,
    val pinkInk: androidx.compose.ui.graphics.Color,
    val danger: androidx.compose.ui.graphics.Color,
    val warn: androidx.compose.ui.graphics.Color,
    val ok: androidx.compose.ui.graphics.Color,
)

val LocalEchoColors = staticCompositionLocalOf {
    EchoSoulColors(
        paper = Ink.paper, paperWarm = Ink.paper_warm, paperDeep = Ink.paper_deep,
        ink = Ink.ink, inkSoft = Ink.ink_soft, inkFaint = Ink.ink_faint,
        hairline = Ink.hairline, hairlineStrong = Ink.hairline_strong,
        accent = Ink.accent, accentDeep = Ink.accent_deep, accentPress = Ink.blue_press,
        accentTint = Ink.blue_tint, pink = Ink.pink, pinkDeep = Ink.pink_deep, pinkTint = Ink.pink_tint,
        pinkInk = Ink.pink_ink,
        danger = Ink.danger, warn = Ink.warn, ok = Ink.ok,
    )
}

private fun echoLightColors() = lightColorScheme(
    primary = Ink.blue_deep,
    onPrimary = Ink.paper,
    primaryContainer = Ink.blue_tint,
    onPrimaryContainer = Ink.blue_ink,
    secondary = Ink.pink_deep,
    onSecondary = Ink.paper,
    secondaryContainer = Ink.pink_tint,
    onSecondaryContainer = Ink.pink_ink,
    tertiary = Ink.blue,
    onTertiary = Ink.paper,
    background = Ink.paper,
    onBackground = Ink.ink,
    surface = Ink.paper,
    onSurface = Ink.ink,
    surfaceVariant = Ink.paper_warm,
    onSurfaceVariant = Ink.ink_soft,
    outline = Ink.hairline_strong,
    outlineVariant = Ink.hairline,
    error = Ink.danger,
    onError = Ink.paper,
    // scrim 用一点暖黑，不要纯黑（纸质视觉里纯黑太硬）
    scrim = Ink.ink,
)

private fun echoDarkColors() = darkColorScheme(
    primary = Ink.blue,
    onPrimary = Ink.blue_ink,
    primaryContainer = Ink.blue_deep,
    onPrimaryContainer = Ink.blue_tint,
    secondary = Ink.pink,
    onSecondary = Ink.pink_ink,
    secondaryContainer = Ink.pink_deep,
    onSecondaryContainer = Ink.pink_tint,
    tertiary = Ink.blue,
    onTertiary = Ink.blue_ink,
    // 暗色纸 = 压深的暖褐，不是纯黑：夜间读对话不刺眼
    background = Ink.ink,
    onBackground = Ink.paper,
    surface = Ink.ink,
    onSurface = Ink.paper,
    surfaceVariant = Ink.ink_soft,
    onSurfaceVariant = Ink.paper_warm,
    outline = Ink.ink_faint,
    outlineVariant = Ink.ink_soft,
    error = Ink.pink_deep,
    onError = Ink.paper,
    scrim = Ink.ink,
)

/**
 * 排版：MinSans / 系统默认（不内嵌第三方字体，省包体）。
 * 标题用偏重的字重强化"角色在说话"的手感；正文行高给足，长回答不挤。
 */
private fun echoTypography(): Typography = Typography(
    displaySmall = TextStyle(fontSize = 30.sp, lineHeight = 38.sp, fontWeight = FontWeight.SemiBold),
    headlineMedium = TextStyle(fontSize = 24.sp, lineHeight = 32.sp, fontWeight = FontWeight.SemiBold),
    headlineSmall = TextStyle(fontSize = 20.sp, lineHeight = 28.sp, fontWeight = FontWeight.Medium),
    titleLarge = TextStyle(fontSize = 18.sp, lineHeight = 26.sp, fontWeight = FontWeight.Medium),
    titleMedium = TextStyle(fontSize = 16.sp, lineHeight = 24.sp, fontWeight = FontWeight.Medium),
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 26.sp, fontWeight = FontWeight.Normal),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 22.sp, fontWeight = FontWeight.Normal),
    bodySmall = TextStyle(fontSize = 12.sp, lineHeight = 18.sp, fontWeight = FontWeight.Normal),
    labelLarge = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium),
    labelSmall = TextStyle(fontSize = 11.sp, lineHeight = 16.sp, fontWeight = FontWeight.Normal),
)

/** 低端机：动效时长归零（关闭过渡动画），由 App 层传入。 */
val LocalReduceMotion = staticCompositionLocalOf { false }

@Composable
fun EchoSoulTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    reduceMotion: Boolean = false,
    content: @Composable () -> Unit,
) {
    val scheme = if (darkTheme) echoDarkColors() else echoLightColors()
    val colors = if (darkTheme) {
        LocalEchoColors.current.copy(
            paper = Ink.ink, paperWarm = Ink.ink_soft, paperDeep = Ink.ink_faint,
            ink = Ink.paper, inkSoft = Ink.paper_warm, inkFaint = Ink.hairline_strong,
        )
    } else {
        LocalEchoColors.current
    }
    CompositionLocalProvider(
        LocalEchoColors provides colors,
        LocalReduceMotion provides reduceMotion,
    ) {
        MaterialTheme(
            colorScheme = scheme,
            typography = echoTypography(),
            shapes = androidx.compose.material3.Shapes(
                extraSmall = androidx.compose.foundation.shape.RoundedCornerShape(Space.n2),
                small = androidx.compose.foundation.shape.RoundedCornerShape(Space.n3),
                medium = androidx.compose.foundation.shape.RoundedCornerShape(Space.n4),
                large = androidx.compose.foundation.shape.RoundedCornerShape(Space.n5),
                extraLarge = androidx.compose.foundation.shape.RoundedCornerShape(Space.n6),
            ),
            content = content,
        )
    }
}

/** 便捷取色：UI 里 EchoColors.accent 比 MaterialTheme.colorScheme.primary 语义更清楚。 */
object EchoColors {
    val current: EchoSoulColors
        @Composable get() = LocalEchoColors.current
}
