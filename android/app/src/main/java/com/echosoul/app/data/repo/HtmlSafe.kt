package com.echosoul.app.data.repo

/**
 * 纯文本化：把服务端可能夹带的 HTML 标签剥掉，只留文字。
 *
 * ★ 为什么安卓也要做这件事：网页端用 textContent 天然免疫，安卓如果直接
 *   BasicText 渲染，`<b>` 之类会**原样显示成尖括号**（不是 XSS，是难看的脏数据）。
 *   这里只做最小剥离，不引 HTML 解析库：正文里的合法尖括号（比如 "3 < 5"）
 *   由服务端保证不出现，客户端不做富文本渲染。
 */
object HtmlSafe {

    private val TAG = Regex("<[^>]{1,400}>")
    private val ENTITIES = mapOf(
        "&amp;" to "&",
        "&lt;" to "<",
        "&gt;" to ">",
        "&quot;" to "\"",
        "&#39;" to "'",
        "&nbsp;" to " ",
    )

    fun plain(raw: String): String {
        if (raw.indexOf('<') < 0 && raw.indexOf('&') < 0) return raw
        var out = TAG.replace(raw, "")
        for ((k, v) in ENTITIES) out = out.replace(k, v)
        return out
    }
}
