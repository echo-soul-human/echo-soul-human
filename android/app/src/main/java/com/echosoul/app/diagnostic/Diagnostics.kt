package com.echosoul.app.diagnostic

import android.os.Build
import android.os.Process
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.system.exitProcess
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * 崩溃诊断：本地环形缓冲 + 设置页导出复制。★ **绝不静默上传**（分册 §1、待确认 A4 定案）。
 *
 * 三条设计约束：
 *   1. **写入路径零 IO**：条目只进内存环形缓冲；落盘只在用户点「导出」或进程即将死时做。
 *      Application.onCreate 里做任何磁盘写都会吃掉冷启动预算（P0 ≤1.5s，§12）。
 *   2. 有字段黑名单（见 [redact]）：令牌、Key、正文一律不落诊断。
 *      BYOK Key 本来就不进客户端存储（E5/G1），这里防的是"顺手把请求体记下来"。
 *   3. 未捕获异常先落盘再交回系统默认处理器 —— 顺序反了就等于什么都没记。
 */
@Singleton
class Diagnostics @Inject constructor() {

    private val lock = Any()
    private val ring = ArrayDeque<Entry>(CAPACITY)
    private val startedAt = System.currentTimeMillis()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Volatile private var file: File? = null

    /** 低端机标记由 Perf 在 Application 里注入，导出时要能看出来是不是机型差异。 */
    @Volatile var lowRamDevice: Boolean = false

    fun info(tag: String, msg: String) = add(Level.INFO, tag, msg, null)
    fun warn(tag: String, msg: String) = add(Level.WARN, tag, msg, null)
    fun error(tag: String, msg: String, t: Throwable? = null) = add(Level.ERROR, tag, msg, t)
    fun debug(tag: String, msg: String) = add(Level.DEBUG, tag, msg, null)

    private fun add(level: Level, tag: String, msg: String, t: Throwable?) {
        val entry = Entry(
            at = System.currentTimeMillis(),
            level = level,
            tag = tag,
            // 截断优先于完整：一条 8KB 的 SSE data 会把整个缓冲挤掉。
            msg = redact(msg).take(MAX_MSG),
            throwable = t?.let { stackOf(it) }?.take(MAX_STACK),
        )
        synchronized(lock) {
            if (ring.size >= CAPACITY) ring.pollFirst()
            ring.addLast(entry)
        }
    }

    /** 给 UI 直接渲染的快照（旧 → 新）。 */
    fun snapshot(): List<Entry> = synchronized(lock) { ring.toList() }

    /** 导出文本：设置页「导出并复制」用。带设备与版本头，方便对着 versionCode 排障。 */
    fun dump(): String = buildString {
        appendLine("星回 EchoSoul 诊断日志")
        appendLine("导出时间 ${TIME_FULL.format(Date())}")
        appendLine("版本 ${com.echosoul.app.BuildConfig.VERSION_NAME} (${com.echosoul.app.BuildConfig.VERSION_CODE})")
        appendLine("设备 ${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE} (api ${Build.VERSION.SDK_INT})")
        appendLine("pid=${Process.myPid()} · 存活 ${((System.currentTimeMillis() - startedAt) / 1000)}s")
        appendLine("低内存机型 ${if (lowRamDevice) "是" else "否"}")
        appendLine(DIVIDER)
        snapshot().forEach { e ->
            appendLine("${TIME_MS.format(Date(e.at))} ${e.level.tag}/${e.tag}: ${e.msg}")
            e.throwable?.let { appendLine(it) }
        }
        appendLine(DIVIDER)
        appendLine("说明：这些内容只留在本机，应用不会自动上传。")
    }

    /** 目标文件位置（filesDir 下，被 data_extraction_rules 排除备份）。 */
    fun diagnosticFile(dir: File): File = File(dir, FILE_NAME).also { file = it }

    /** 只有显式调用才落盘 —— 正常路径上不产生任何 IO。 */
    fun flushToDisk() {
        val target = file ?: return
        val text = dump()
        scope.launch { runCatching { target.writeText(text) } }
    }

    fun installCrashHandler() {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            add(Level.ERROR, "crash", "uncaught on ${thread.name}", error)
            // 进程要死了，异步来不及：同步写一次。
            runCatching { file?.writeText(dump()) }
            previous?.uncaughtException(thread, error)
            exitProcess(EXIT_CODE)
        }
    }

    data class Entry(val at: Long, val level: Level, val tag: String, val msg: String, val throwable: String?)

    enum class Level(val tag: String) { DEBUG("D"), INFO("I"), WARN("W"), ERROR("E") }

    private fun stackOf(t: Throwable): String = StringWriter().also { w -> t.printStackTrace(PrintWriter(w)) }.toString()

    private companion object {
        const val CAPACITY = 600
        const val MAX_MSG = 400
        const val MAX_STACK = 2000
        const val FILE_NAME = "echosoul-diagnostics.txt"
        const val EXIT_CODE = 10
        const val DIVIDER = "------------------------------------------------"
        val TIME_FULL = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US)
        val TIME_MS = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)
    }
}

/**
 * 敏感串过滤。宁可少记录，也不要哪天因为一次 log 把令牌写进用户导出的文件里。
 * ★ 这是第二道防线；第一道是"BYOK Key 根本不进客户端存储"。
 */
internal fun redact(input: String): String {
    var out = input
    for (marker in LITERAL_MARKERS) out = out.replace(marker, "$marker=***")
    out = BEARER.replace(out) { "Bearer ***" }
    out = KEY_LIKE.replace(out) { m ->
        val value = m.groupValues[2]
        val tail = if (value.length > 8) value.takeLast(4) else ""
        "${m.groupValues[1]}${m.groupValues[3]}***$tail"
    }
    return out
}

private val LITERAL_MARKERS = listOf("refresh_token", "wrapped_dk", "encrypted_key")
private val BEARER = Regex("Bearer\\s+[A-Za-z0-9._~+/=-]+")
private val KEY_LIKE = Regex(
    """([a-z_]*(?:token|key|secret|password)[a-z_]*)\s*[:=]\s*"?([^"\s,}]{4,})""",
    RegexOption.IGNORE_CASE,
)
