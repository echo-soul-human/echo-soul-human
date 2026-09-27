package com.echosoul.app.data.local

/**
 * Room 迁移纪律（分册 §10：禁止 fallbackToDestructiveMigration）。
 *
 * ## 什么改动需要手写 Migration
 * Room 能**证明无损**的改动可以 autoMigrate：新增表、新增带默认值的列、增删索引。
 * 其余一律要显式写：改列类型、删非空列、改名（除非登记 AutoMigrationSpec）。
 *
 * ## 本库的特殊性：它是可弃缓存
 * cached_messages / session_index 清空只影响"下次进会话多等一次网络"；
 * drafts / outbox **不能丢** —— 一个是用户没发出去的话，一个是已经付过钱的幂等键。
 * 所以真要做大改形，正确姿势是：
 *   1. 新库名或新 version + 一条 Migration，把 drafts/outbox 逐列搬走；
 *   2. 缓存表直接重建（DROP + CREATE），因为它本来就不是真源。
 * 反过来做就是事故：**绝不能为了省事把 destructive 打开**。
 *
 * ##  uuid 语义提醒
 * messages.id 在服务端是 `gen_random_uuid()`（v4 随机），**不单调不可排序**。
 * 因此 LRU 与插入顺序都以 created_at / cached_at 为准，id 只用于去重。
 * 若将来服务端换成 uuidv7，这里和 realtime 的去重逻辑都要一起重审。
 *
 * ## 编译期防线
 * gradle.properties 里 ksp 已配 room.schemaLocation=app/schemas；CI 要检查
 * schemas/*.json 随 version 一起变更（schema 文件没动却升了 version = 漏写迁移）。
 */
object MigrationNotes
