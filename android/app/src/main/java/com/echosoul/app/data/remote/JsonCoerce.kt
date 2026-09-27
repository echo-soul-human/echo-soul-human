package com.echosoul.app.data.remote

import java.io.IOException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * 服务端错误的统一异常。code 取契约里的 ErrorCode（shared/contract/api.json）。
 * 留 String 不留 enum，是为了服务端新增码不把旧客户端编译打断 —— 与生成物里
 * ChatError.code 的类型选择同一个理由。
 */
class ApiException(val code: String, message: String) : IOException(message)

// ─── JsonElement 收窄小工具 ────────────────────────────────
// PostgREST 的列类型不严格：uuid 会以 string 回来、int 有时是 number 有时是 string、
// text[] 是 JsonArray。与其在 DTO 上赌类型（赌错了就是 release 才崩的 ClassCastException），
// 不如在这一层把兜底写全。

fun JsonElement.asObj(): JsonObject = this as? JsonObject ?: JsonObject(emptyMap())

fun JsonElement.asArr(): JsonArray = this as? JsonArray ?: JsonArray(emptyList())

fun JsonObject.str(key: String): String? {
    val el = this[key] ?: return null
    if (el is JsonNull) return null
    return (el as? JsonPrimitive)?.content ?: el.toString()
}

fun JsonObject.strOr(key: String, default: String = ""): String = str(key) ?: default

fun JsonObject.intOr(key: String, default: Int = 0): Int = str(key)?.trim()?.toIntOrNull() ?: default

fun JsonObject.longOr(key: String, default: Long = 0L): Long = str(key)?.trim()?.toLongOrNull() ?: default

fun JsonObject.doubleOr(key: String, default: Double = 0.0): Double = str(key)?.trim()?.toDoubleOrNull() ?: default

fun JsonObject.boolOr(key: String, default: Boolean = false): Boolean = when (str(key)?.trim()?.lowercase()) {
    "true", "t", "1" -> true
    "false", "f", "0" -> false
    else -> default
}

fun JsonObject.strList(key: String): List<String> =
    (this[key] as? JsonArray)?.mapNotNull { el -> if (el is JsonNull) null else (el as? JsonPrimitive)?.content }
        ?: emptyList()

fun JsonObject.nestedStrList(key: String): List<List<String>> =
    (this[key] as? JsonArray)?.map { row ->
        (row as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content } ?: emptyList()
    } ?: emptyList()

fun JsonObject.boolMap(key: String): Map<String, Boolean> {
    val obj = this[key] as? JsonObject ?: return emptyMap()
    return obj.mapNotNull { (k, v) ->
        if (v is JsonNull) null else k to (v.contentEquals("true"))
    }.toMap()
}

private fun JsonPrimitive.contentEquals(other: String): Boolean = content.trim().lowercase() == other

fun buildObject(vararg pairs: Pair<String, Any?>): JsonObject {
    val filtered = pairs.filterNot { (_, v) -> v == null }
    return JsonObject(filtered.associate { (k, v) -> k to toJsonElement(v) })
}

fun toJsonElement(value: Any?): JsonElement = when (value) {
    null -> JsonNull
    is JsonElement -> value
    is String -> JsonPrimitive(value)
    is Number -> JsonPrimitive(value)
    is Boolean -> JsonPrimitive(value)
    is List<*> -> JsonArray(value.map { toJsonElement(it) })
    is Map<*, *> -> JsonObject(value.entries.associate { (k, v) -> k.toString() to toJsonElement(v) })
    else -> JsonPrimitive(value.toString())
}
