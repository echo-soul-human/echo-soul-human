-- 001_extensions.sql
-- 扩展启用。幂等：可重复执行。
-- 规范见 docs/分册-后端与数据库.md §2

create extension if not exists vector;      -- pgvector：长期记忆向量检索
create extension if not exists pg_trgm;     -- 三元组相似度：关键词通道 + 模糊匹配
create extension if not exists citext;      -- 大小写不敏感唯一（handle / slug）
create extension if not exists pgcrypto;    -- gen_random_uuid()

-- ─── 自检 ───────────────────────────────────────────────
-- 执行后下方四列必须全为 true，否则说明实例未开放对应扩展，
-- 后续迁移会在 create index 处静默失败。
select
  exists(select 1 from pg_extension where extname = 'vector')   as vector_ok,
  exists(select 1 from pg_extension where extname = 'pg_trgm')  as trgm_ok,
  exists(select 1 from pg_extension where extname = 'citext')   as citext_ok,
  exists(select 1 from pg_extension where extname = 'pgcrypto') as pgcrypto_ok;
