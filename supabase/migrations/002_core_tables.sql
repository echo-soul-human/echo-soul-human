-- 002_core_tables.sql
-- 核心表：用户扩展、商品目录、权益、角色、会话、消息
-- 规范：幂等（可重复执行）、金额 numeric(12,4)、时间 timestamptz
-- 见 docs/分册-后端与数据库.md §3

-- ─── 枚举（重复创建会报错，故先判存在）─────────────────────
do $do$
begin
  if not exists (select 1 from pg_type where typname = 'tier_t') then
    create type public.tier_t as enum ('free','lite','pro','pro_plus','ultra');
  end if;
  if not exists (select 1 from pg_type where typname = 'msg_role') then
    create type public.msg_role as enum ('user','assistant','system','proactive');
  end if;
  if not exists (select 1 from pg_type where typname = 'mem_kind') then
    create type public.mem_kind as enum ('fact','episode','summary');
  end if;
  if not exists (select 1 from pg_type where typname = 'stage_t') then
    create type public.stage_t as enum ('stranger','acquainted','close','ambiguous','established');
  end if;
end
$do$;

-- ─── 用户扩展 ────────────────────────────────────────────
create table if not exists public.profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  handle         citext unique,
  nickname       text not null default '',
  avatar_path    text,
  afdian_user_id text unique,              -- 爱发电账号标识，用于订单归因（17 号专篇 L1）
  birth_declared date,                     -- 年龄声明，加密由列级默认策略兜底（08/27 号专篇）
  created_at     timestamptz not null default now(),
  last_seen_at   timestamptz,
  banned_until   timestamptz,
  settings       jsonb not null default '{}'::jsonb
);

create index if not exists idx_profiles_afdian on public.profiles(afdian_user_id)
  where afdian_user_id is not null;

-- ─── 商品目录：档位 / 年包 / 加量包 ───────────────────────
-- 有效期一律 31 或 372 天，不使用"月"（16 号专篇 §1.1）
create table if not exists public.plan_catalog (
  id                 text primary key,          -- 'lite_31' | 'pro_372' | 'pack_98'
  tier               public.tier_t not null,
  afdian_plan_id     text unique,               -- 爱发电侧方案 ID（webhook 的 plan_id）
  afdian_sku_id      text,                      -- 售卖型商品的型号 ID
  price_cny          numeric(12,2) not null,
  grant_credit       numeric(12,4) not null,    -- 随附额度（零售价）
  valid_days         int not null check (valid_days in (31, 372) or is_addon),
  is_addon           boolean not null default false,
  is_annual          boolean not null default false,
  active             boolean not null default true,
  updated_at         timestamptz not null default now()
);

-- ★ 顺序要求：先补列，再 upsert。
--   否则全新库里该列尚不存在；已应用库里走默认值又会违反随后要加的约束。
alter table public.plan_catalog
  add column if not exists credit_valid_days int not null default 31;

-- 初始目录：与 docs/HANDOFF.md §4 定案一致
-- 年包折扣率 549/588=93.4%、888/948=93.7%、1299/1428=91.0%，均在 90~95% 带内
-- ★ credit_valid_days 必须显式给出，理由见上
insert into public.plan_catalog
  (id, tier, price_cny, grant_credit, valid_days, is_addon, is_annual, credit_valid_days)
values
  ('lite_31',     'lite',      19.00,    45.0000,  31, false, false,  31),
  ('pro_31',      'pro',       49.00,   130.0000,  31, false, false,  31),
  ('pro_plus_31', 'pro_plus',  79.00,   230.0000,  31, false, false,  31),
  ('ultra_31',    'ultra',    119.00,   400.0000,  31, false, false,  31),
  ('pro_372',     'pro',      549.00,  1560.0000, 372, false, true,  372),
  ('pro_plus_372','pro_plus', 888.00,  2760.0000, 372, false, true,  372),
  ('ultra_372',   'ultra',   1299.00,  4800.0000, 372, false, true,  372),
  ('pack_6',      'free',      6.00,     9.0000,   0, true,  false,  372),
  ('pack_18',     'free',     18.00,    30.0000,   0, true,  false,  372),
  ('pack_48',     'free',     48.00,    85.0000,   0, true,  false,  372),
  ('pack_98',     'free',     98.00,   180.0000,   0, true,  false,  372)
on conflict (id) do update
   set price_cny          = excluded.price_cny,
       grant_credit       = excluded.grant_credit,
       valid_days         = excluded.valid_days,
       is_addon           = excluded.is_addon,
       is_annual          = excluded.is_annual,
       credit_valid_days  = excluded.credit_valid_days;

-- 回填：兼容本列引入之前已存在的行（新库上这是空操作）
update public.plan_catalog
   set credit_valid_days = case when is_addon then 372 else valid_days end
 where credit_valid_days is distinct from case when is_addon then 372 else valid_days end;

alter table public.plan_catalog drop constraint if exists ck_plan_credit_expiry;
alter table public.plan_catalog add constraint ck_plan_credit_expiry
  check (
    case
      when is_addon then credit_valid_days = 372
      else credit_valid_days = valid_days
    end
  );

-- ─── 权益快照（参数落库不写死在代码里，16 号专篇 §3）─────
create table if not exists public.entitlements (
  user_id            uuid primary key references public.profiles(id) on delete cascade,
  tier               public.tier_t not null default 'free',
  expires_at         timestamptz,                    -- free 为 null
  character_slots    int not null default 1,
  window_limit       int not null default 262144,    -- 模型上下文窗口上限
  carry_tokens       int not null default 8192,      -- 每轮实际携带历史上限
  carry_default      int not null default 8192,      -- 默认携带（Ultra 上限 512K 但默认 64K）
  recall_topk        int not null default 4,
  group_member_max   int not null default 2,
  skin_quota         int not null default 1,
  sticker_quota      int not null default 20,
  proactive_per_day  int not null default 0,
  tts_voice_profile  text,
  credit_expiry      timestamptz,                    -- 额度有效期（加量包独立计）
  updated_at         timestamptz not null default now()
);

-- 档位默认值函数：发放权益与注册初始化共用，避免两处写死
create or replace function public.tier_defaults(p_tier public.tier_t)
returns jsonb language sql immutable set search_path = pg_catalog, public as $fn$
  select case p_tier
    when 'free'      then '{"character_slots":1,"window_limit":262144,"carry_tokens":8192,"carry_default":8192,"recall_topk":4,"group_member_max":2,"skin_quota":1,"sticker_quota":20,"proactive_per_day":0}'::jsonb
    when 'lite'      then '{"character_slots":2,"window_limit":262144,"carry_tokens":16384,"carry_default":16384,"recall_topk":6,"group_member_max":3,"skin_quota":3,"sticker_quota":100,"proactive_per_day":0}'::jsonb
    when 'pro'       then '{"character_slots":4,"window_limit":262144,"carry_tokens":49152,"carry_default":49152,"recall_topk":8,"group_member_max":4,"skin_quota":8,"sticker_quota":500,"proactive_per_day":1}'::jsonb
    when 'pro_plus'  then '{"character_slots":8,"window_limit":1048576,"carry_tokens":131072,"carry_default":65536,"recall_topk":12,"group_member_max":6,"skin_quota":9999,"sticker_quota":999999,"proactive_per_day":2}'::jsonb
    when 'ultra'     then '{"character_slots":16,"window_limit":1048576,"carry_tokens":524288,"carry_default":65536,"recall_topk":20,"group_member_max":8,"skin_quota":9999,"sticker_quota":999999,"proactive_per_day":3}'::jsonb
  end;
$fn$;

-- 把档位参数应用到权益行（发放与升档共用）
create or replace function public.apply_tier(p_user uuid, p_tier public.tier_t)
returns void language sql volatile set search_path = pg_catalog, public as $fn$
  update public.entitlements e
     set tier              = p_tier,
         character_slots   = (d->>'character_slots')::int,
         window_limit      = (d->>'window_limit')::int,
         carry_tokens      = (d->>'carry_tokens')::int,
         carry_default     = (d->>'carry_default')::int,
         recall_topk       = (d->>'recall_topk')::int,
         group_member_max  = (d->>'group_member_max')::int,
         skin_quota        = (d->>'skin_quota')::int,
         sticker_quota     = (d->>'sticker_quota')::int,
         proactive_per_day = (d->>'proactive_per_day')::int,
         updated_at        = now()
    from (select public.tier_defaults(p_tier) as d) x
   where e.user_id = p_user;
$fn$;

-- 新账号自动建 profiles / entitlements / balances（注册即可用，不需人工）
-- ★ 三张伴生行必须在同一个触发器内按序创建。
--   Postgres 对同时机触发器按「名字字母序」执行：若把 balances 拆到另一个
--   命名更靠前的触发器，它会在 profiles 尚不存在时插入并撞外键，
--   线上新用户注册直接失败。这个坑由 scripts/verify-db.mjs 抓到。
--   balances 表在 003 建立；plpgsql 延迟解析，故此处创建函数不受影响。
create or replace function public.on_user_created()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $fn$
declare d jsonb;
begin
  insert into public.profiles (id) values (new.id)
    on conflict (id) do nothing;

  d := public.tier_defaults('free');
  insert into public.entitlements (
    user_id, tier, character_slots, window_limit, carry_tokens, carry_default,
    recall_topk, group_member_max, skin_quota, sticker_quota, proactive_per_day
  ) values (
    new.id, 'free',
    (d->>'character_slots')::int, (d->>'window_limit')::int, (d->>'carry_tokens')::int,
    (d->>'carry_default')::int, (d->>'recall_topk')::int, (d->>'group_member_max')::int,
    (d->>'skin_quota')::int, (d->>'sticker_quota')::int, (d->>'proactive_per_day')::int
  ) on conflict (user_id) do nothing;

  insert into public.balances (user_id) values (new.id)
    on conflict (user_id) do nothing;

  return new;
end;
$fn$;

drop trigger if exists trg_user_balance on auth.users;
drop function if exists public.on_user_created_v2();

drop trigger if exists trg_user_created on auth.users;
create trigger trg_user_created
  after insert on auth.users
  for each row execute function public.on_user_created();

-- ─── 角色 ────────────────────────────────────────────────
create table if not exists public.characters (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid references public.profiles(id) on delete set null,  -- null = 官方
  slug              citext unique,
  name              text not null,
  tagline           text not null default '',
  avatar_path       text,
  portrait_path     text,
  greeting          text not null default '',
  persona_text      text not null default '',
  example_dialogs   jsonb not null default '[]'::jsonb,   -- 定人设靠示例对话，不靠形容词
  behavior_notes    text not null default '',
  voice_profile_id  text,
  rarity            text,
  tags              text[] not null default '{}',
  visibility        text not null default 'private'
                      check (visibility in ('private','unlisted','public')),
  published_version int not null default 0,
  ccv2              jsonb,                                 -- CCv2 兼容层（二期导入）
  emotion_portraits jsonb not null default '{}'::jsonb,    -- 立绘差分：情绪 → 图
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_char_owner  on public.characters(owner_id) where owner_id is not null;
create index if not exists idx_char_public on public.characters(visibility, created_at desc)
  where visibility = 'public';
create index if not exists idx_char_tags   on public.characters using gin(tags);

-- 人设版本历史：改人设不重写已发生的记忆（架构 §4 规则 2）
create table if not exists public.character_versions (
  character_id    uuid not null references public.characters(id) on delete cascade,
  version         int  not null,
  persona_text    text not null,
  example_dialogs jsonb not null,
  behavior_notes  text not null default '',
  created_at      timestamptz not null default now(),
  primary key (character_id, version)
);

-- ★★★ 隐藏锁：用户侧零读（01/04/C8 定案的数据库层兜底）
create table if not exists public.character_locks (
  character_id     uuid primary key references public.characters(id) on delete cascade,
  lock_text        text not null,
  static_hash      text not null,        -- 与 prefix.lock.json 同源的校验值
  anti_drift_reply text not null default '',
  boundaries       text not null default '',
  updated_at       timestamptz not null default now()
);

-- ─── 会话与成员（单聊也走 members，二期群聊零迁移）────────
create table if not exists public.sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  kind          text not null default 'solo' check (kind in ('solo','group')),
  title         text,
  carry_tokens  int,                      -- 用户手动覆盖档位默认
  last_msg_at   timestamptz,
  archived_at   timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists idx_sessions_user_recent
  on public.sessions(user_id, last_msg_at desc nulls last);

create table if not exists public.session_members (
  session_id    uuid not null references public.sessions(id) on delete cascade,
  character_id  uuid not null references public.characters(id) on delete cascade,
  seat          int  not null,
  primary key (session_id, character_id)
);

create table if not exists public.messages (
  id               uuid primary key default gen_random_uuid(),
  session_id       uuid not null references public.sessions(id) on delete cascade,
  user_id          uuid not null,                    -- 冗余：RLS 与未来分区
  role             public.msg_role not null,
  character_id     uuid references public.characters(id),
  content          text not null default '',
  origin           text not null default 'client'
                     check (origin in ('client','proactive','imported')),
  partial          boolean not null default false,
  usage_prompt     int,
  usage_completion int,
  usage_cached     int,
  cost_actual      numeric(12,6),
  request_id       uuid,                             -- 关联账本，幂等
  read_at          timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists idx_msg_session_time on public.messages(session_id, created_at desc);
create index if not exists idx_msg_user_time    on public.messages(user_id, created_at desc);
create index if not exists idx_msg_request      on public.messages(request_id) where request_id is not null;

-- 会话内成员数不得超过档位上限（C7 群聊 + 16 号专篇 §3.1）
create or replace function public.guard_group_size()
returns trigger language plpgsql set search_path = pg_catalog, public as $fn$
declare
  v_user uuid; v_max int; v_now int;
begin
  select user_id into v_user from public.sessions where id = new.session_id;
  if v_user is null then
    raise exception 'session % not found', new.session_id;
  end if;
  select group_member_max into v_max from public.entitlements where user_id = v_user;
  select count(*) into v_now from public.session_members where session_id = new.session_id;
  if coalesce(v_max, 2) <= v_now then
    raise exception 'group member limit reached (%) for tier', v_max;
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_group_size on public.session_members;
create trigger trg_group_size
  before insert on public.session_members
  for each row execute function public.guard_group_size();

-- 消息写入时刷新会话活跃时间
create or replace function public.touch_session()
returns trigger language plpgsql set search_path = pg_catalog, public as $fn$
begin
  update public.sessions set last_msg_at = new.created_at where id = new.session_id;
  return new;
end;
$fn$;

drop trigger if exists trg_touch_session on public.messages;
create trigger trg_touch_session
  after insert on public.messages
  for each row execute function public.touch_session();

-- ─── 自检 ───────────────────────────────────────────────
-- 执行后各列必须为 true（见 docs/分册-后端与数据库.md §2 规则 3）
select
  (select count(*) from pg_catalog.pg_tables
     where schemaname='public' and tablename in
     ('profiles','plan_catalog','entitlements','characters','character_versions',
      'character_locks','sessions','session_members','messages')) = 9          as tables_ok,
  (select count(*) from public.plan_catalog) >= 11                              as catalog_ok,
  (select count(*) from public.plan_catalog p
     where p.is_annual and p.price_cny / (
       (select p2.price_cny from public.plan_catalog p2
         where p2.tier = p.tier and not p2.is_annual) * 12) not between 0.90 and 0.95
  ) = 0                                                                          as annual_discount_ok,
  (select count(*) from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname in
     ('tier_defaults','apply_tier','on_user_created','guard_group_size','touch_session')) = 5
                                                                                 as functions_ok,
  (select (public.tier_defaults('ultra')->>'carry_default')::int) = 65536        as ultra_default_carry_ok,
  (select (public.tier_defaults('ultra')->>'carry_tokens')::int)  = 524288       as ultra_ceiling_ok;
