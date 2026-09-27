package com.echosoul.app.data.local

import androidx.room.Database
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

/**
 * 本地渲染缓存库。
 *
 * ★ **禁止 fallbackToDestructiveMigration()**（分册 §10）：它会静默丢掉用户缓存，
 *   表现是"我明明看过的消息没了"，不报错、最难查。所以：
 *     - exportSchema = true，schema JSON 落在 app/schemas/ 并纳入版本控制；
 *     - 每次升 version 必须同时补一条 [MIGRATIONS] 里的条目，MigrationTest 会验证。
 *
 * 本库从来不是真源：任何时候清空它，用户数据都在 Postgres 里（E1 定案）。
 */
@Database(
    entities = [
        CachedMessage::class,
        DraftRow::class,
        OutboxRow::class,
        SessionIndexEntity::class,
    ],
    version = EchoSoulDatabase.VERSION,
    exportSchema = true,
)
abstract class EchoSoulDatabase : RoomDatabase() {
    abstract fun messageCache(): MessageCacheDao
    abstract fun drafts(): DraftDao
    abstract fun outbox(): OutboxDao
    abstract fun sessionIndex(): SessionIndexDao

    companion object {
        const val NAME = "echosoul-cache.db"
        const val VERSION = 1

        /**
         * 唯一的迁移表。**升 VERSION 而不在这里加条目 = 老用户升级即丢缓存**，
         * MigrationTest#migrationsCoverEveryVersion 就是拦这件事的。
         */
        val MIGRATIONS: Array<Migration> = arrayOf(
            // 示例（下一版启用时取消注释并同步 VERSION）：
            // object : Migration(1, 2) {
            //     override fun migrate(db: SupportSQLiteDatabase) {
            //         db.execSQL("ALTER TABLE drafts ADD COLUMN draft_kind TEXT NOT NULL DEFAULT ''")
            //     }
            // },
        )
    }
}

/** 给 MigrationTest 用的类型别名，避免测试里 import 两个同名 SupportSQLiteDatabase。 */
typealias SqlDb = SupportSQLiteDatabase
