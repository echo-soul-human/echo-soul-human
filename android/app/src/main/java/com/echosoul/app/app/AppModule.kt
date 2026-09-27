package com.echosoul.app.app

import android.content.Context
import androidx.room.Room
import com.echosoul.app.data.local.DraftDao
import com.echosoul.app.data.local.EchoSoulDatabase
import com.echosoul.app.data.local.MessageCacheDao
import com.echosoul.app.data.local.OutboxDao
import com.echosoul.app.data.local.SessionIndexDao
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * 全局依赖装配。只提供"构造需要 Context 且不能用 @Inject 直接造"的东西（Room、DAO）。
 *
 * ★ 数据库**懒加载**（by lazy 语义由 Hilt 的 @Singleton 保证：首次注入才建）。
 *   冷启动路径如果不注入 DAO，就不会碰 SQLite —— 这是 ≤1.5s 预算的一部分。
 * ★ 禁用 fallbackToDestructiveMigration（分册 §10）：迁移缺失宁可崩，也不静默丢用户数据。
 */
@Module
@InstallIn(SingletonComponent::class)
object AppModule {

    @Provides
    @Singleton
    fun provideDatabase(@ApplicationContext context: Context): EchoSoulDatabase =
        Room.databaseBuilder(context, EchoSoulDatabase::class.java, EchoSoulDatabase.NAME)
            .addMigrations(*EchoSoulDatabase.MIGRATIONS)
            .build()

    @Provides
    fun provideMessageCacheDao(db: EchoSoulDatabase): MessageCacheDao = db.messageCache()

    @Provides
    fun provideDraftDao(db: EchoSoulDatabase): DraftDao = db.drafts()

    @Provides
    fun provideOutboxDao(db: EchoSoulDatabase): OutboxDao = db.outbox()

    @Provides
    fun provideSessionIndexDao(db: EchoSoulDatabase): SessionIndexDao = db.sessionIndex()
}
