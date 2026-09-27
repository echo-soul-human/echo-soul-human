package com.echosoul.app.ui.navigation

import android.net.Uri

/**
 * 路由定义。全部用**字符串常量 + 参数拼接**，不引 safe-args 插件
 * （少一个 gradle 插件、少一层生成物，路由本身很简单）。
 *
 * ★ 会话 id 走路径参数；角色 id 等也用路径参数。URI 编码在 [build] 里做，
 *   避免 id 里出现 `/` 时把路由切断。
 */
object Routes {
    const val AUTH = "auth"
    const val SESSIONS = "sessions"
    const val CHARACTERS = "characters"
    const val MEMORY = "memory"
    const val BYOK = "byok"
    const val BILLING = "billing"
    const val SETTINGS = "settings"
    const val CHARACTER_NEW = "characters/new"

    const val CHAT = "chat/{sessionId}"
    const val CHARACTER_DETAIL = "characters/{characterId}"

    fun chat(sessionId: String): String = "chat/${Uri.encode(sessionId)}"
    fun characterDetail(characterId: String): String = "characters/${Uri.encode(characterId)}"

    const val ARG_SESSION_ID = "sessionId"
    const val ARG_CHARACTER_ID = "characterId"

    /** 底部导航的常驻入口（聊天/角色/我的），用于判断当前选中项。 */
    val bottomBarRoutes = listOf(SESSIONS, CHARACTERS, SETTINGS)
}
