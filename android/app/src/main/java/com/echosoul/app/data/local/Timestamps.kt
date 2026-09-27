package com.echosoul.app.data.local

import java.time.Instant
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/**
 * 服务端时间戳解析。
 *
 * Postgres `timestamptz` 经 PostgREST/JSON 出来的形态不稳定：
 *   `2026-09-27T16:29:04.512345+08:00`、`2026-09-27 16:29:04+00:00`、秒级无小数段……
 * 因此这里从最精确到最宽松逐个试；**全部失败时返回 null**。
 *
 * ★ 调用方拿到 null 必须放弃这次游标推进，而不是当成 0：
 *   把游标退到纪元起点会让用户重收一整批历史通知，比不推进糟得多。
 *
 * minSdk 26 + coreLibraryDesugaring，java.time 可直接用。
 */
object Timestamps {

    /** epoch 毫秒判定阈值：大于它就当输入已经是毫秒（1973 年以后的秒级值都远小于它）。 */
    private const val EPOCH_MS_THRESHOLD = 10_000_000_000L

    /** 解析为 epoch 毫秒；无法解析返回 null。 */
    fun parseMillis(raw: String?): Long? {
        if (raw.isNullOrBlank()) return null
        val s = raw.trim()

        s.toLongOrNull()?.let { n ->
            return if (n > EPOCH_MS_THRESHOLD) n else n * 1000L
        }

        // 带时区偏移的三种写法
        for (candidate in offsetCandidates(s)) {
            runCatching { return OffsetDateTime.parse(candidate).toInstant().toEpochMilli() }
            runCatching {
                return OffsetDateTime.parse(candidate, FLEXIBLE_OFFSET).toInstant().toEpochMilli()
            }
        }

        // 没带时区的写法：按 UTC 解释。PostgREST 正常都发带偏移的串，走到这里说明中间层
        // 改了格式；此时固定按 UTC 是唯一不会来回漂移的选择。
        for (candidate in localCandidates(s)) {
            runCatching { return LocalDateTime.parse(candidate).toInstant(ZoneOffset.UTC).toEpochMilli() }
            runCatching {
                return LocalDateTime.parse(candidate, FLEXIBLE_LOCAL).toInstant(ZoneOffset.UTC).toEpochMilli()
            }
        }
        return null
    }

    fun formatIsoUtc(epochMs: Long): String = Instant.ofEpochMilli(epochMs).toString()

    /** 首次运行没有游标：从今天往前推 [days] 天开始补，避免把全量历史当新消息弹一遍。 */
    fun sinceFallback(days: Long = DEFAULT_BACKFILL_DAYS): String =
        Instant.now().minusSeconds(days * 86_400L).toString()

    private fun offsetCandidates(s: String): List<String> = listOf(
        s,
        s.replace(' ', 'T'),
        // Postgres 有时给 `-08` 而 ISO 要 `-08:00`
        if (s.matches(Regex(".*[+-]\\d{2}$"))) "$s:00" else s,
    ).distinct()

    private fun localCandidates(s: String): List<String> = listOf(
        s,
        s.replace(' ', 'T'),
    ).distinct()

    private val FLEXIBLE_OFFSET: DateTimeFormatter = DateTimeFormatter.ofPattern(
        "yyyy-MM-dd['T' ]HH:mm:ss[.SSSSSS][.SSS][XXX][XX]",
    )

    private val FLEXIBLE_LOCAL: DateTimeFormatter = DateTimeFormatter.ofPattern(
        "yyyy-MM-dd['T' ]HH:mm:ss[.SSSSSS][.SSS]",
    )

    const val DEFAULT_BACKFILL_DAYS = 3L
}
