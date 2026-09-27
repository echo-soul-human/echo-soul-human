package com.echosoul.app.app

import com.echosoul.app.BuildConfig

/**
 * 构建期注入的全局配置。
 *
 * ★ 这里只允许出现**公开键**（anon key）。service_role 与任何模型 Key 一旦进包，
 *   反编译就是全库裸奔 —— 数据隔离靠 RLS，不靠"不给接口"（架构 §8）。
 *
 * Supabase 地址与 anon key 来自 gradle 环境变量 → BuildConfig：
 * 它们不是秘密，但也不该写死在仓库里（换项目要能只改 CI Secret）。
 */
object AppConfig {

    /** 缺配时客户端显示"配置缺失"页而不是崩；这是判定，不是异常。 */
    val isConfigured: Boolean
        get() = BuildConfig.SUPABASE_URL.isNotBlank() && BuildConfig.SUPABASE_ANON_KEY.isNotBlank()

    val supabaseUrl: String = BuildConfig.SUPABASE_URL.trimEnd('/')

    val anonKey: String = BuildConfig.SUPABASE_ANON_KEY

    val applicationId: String = BuildConfig.APPLICATION_ID

    val versionName: String = BuildConfig.VERSION_NAME

    val versionCode: Int = BuildConfig.VERSION_CODE

    /** 低于它的安装只给更新、不给用（架构 §2.7 min_version_code）。 */
    val minVersionCode: Int = BuildConfig.MIN_VERSION_CODE

    fun functions(name: String): String = "$supabaseUrl/functions/v1/$name"

    /** Supabase REST（PostgREST）。select/insert/rpc 全走这一条。 */
    fun rest(table: String): String = "$supabaseUrl/rest/v1/$table"

    fun rpc(fn: String): String = "$supabaseUrl/rpc/$fn"

    /** Storage 公开桶：APK 分发与立绘都走它，且必须与 /version 下发同域（分册 §7）。 */
    fun storagePublic(bucket: String, path: String): String =
        "$supabaseUrl/storage/v1/object/public/$bucket/${path.trimStart('/')}"

    object Timeouts {
        const val CONNECT_MS = 10_000
        /** 流式必须给足读超时，否则长回答会被掐（分册 §3）。 */
        const val READ_STREAM_MS = 120_000
        const val READ_JSON_MS = 20_000
        const val WRITE_MS = 20_000
        const val CALL_CHAT_MS = 0 // 0 = 不限总时长；由读超时兜底
    }

    object Realtime {
        /** NAT 超时通常 30–60s，心跳取 25s 留余量（分册 §5.2）。 */
        const val HEARTBEAT_MS = 25_000L
        const val PING_TIMEOUT_MS = 10_000L
        const val MAX_MISSED_PONGS = 3
        const val BACKOFF_BASE_MS = 1_000L
        const val BACKOFF_CAP_MS = 300_000L // 5min 封顶
        /** WorkManager 兜底补拉：即使长连接全挂，消息最迟半小时到。 */
        const val FALLBACK_SYNC_MINUTES = 20L
    }

    object Cache {
        /** 每会话渲染缓存上限（LRU 裁到该值）。缓存不是真源，可随时清。 */
        const val MESSAGES_PER_SESSION = 500
    }

    object Perf {
        /** 冷启动预算（P0）：Application.onCreate 里不做任何 IO。 */
        const val COLD_START_BUDGET_MS = 1_500L
    }
}
