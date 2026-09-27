-- 007_runtime_tables.sql
-- 主动关怀队列、推送设备、公告、敏感词规则、分享链接、创作者收益
-- 幂等：可重复执行。末尾带自检。

-- ─── 主动关怀任务（先落库再推送，推送只是提醒）──────────
create table if not exists public.proactive_jobs (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  character_id  uuid not null references public.characters(id) on delete cascade,
  session_id    uuid references public.sessions(id) on delete cascade,
  due_at        timestamptz not null,
  kind          text not null default 'care' check (kind in ('care','memory','anniversary','reply')),
  status        text not null default 'pending'
                  check (status in ('pending','running','sent','skipped','failed')),
  payload       jsonb not null default '{}'::jsonb,
  message_id    uuid,                       -- 生成后落 messages 的引用
  attempts      int not null default 0,
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists uq_proactive_once
  on public.proactive_jobs(user_id, character_id, kind, (payload->>'day'))
  where status in ('pending','sent');
create index if not exists idx_proactive_due on public.proactive_jobs(due_at, status)
  where status = 'pending';

alter table public.proactive_jobs enable row level security;
-- 无 policy ⇒ 用户完全不可见，只有 service_role 能读写

-- ─── 推送订阅（网页 subscription / 安卓 client id）───────
create table if not exists public.push_devices (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  platform       text not null check (platform in ('web','ios-webapp','android','pc')),
  endpoint       text not null,             -- Web Push endpoint 或长连接 client id
  p256dh         text,
  auth           text,
  ua             text not null default '',
  enabled        boolean not null default true,
  last_seen_at   timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  unique (user_id, endpoint)
);
create index if not exists idx_push_user on public.push_devices(user_id) where enabled;

alter table public.push_devices enable row level security;
drop policy if exists p_push_own on public.push_devices;
create policy p_push_own on public.push_devices
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 通知偏好：按角色与类型分别可关
create table if not exists public.notify_prefs (
  user_id        uuid primary key references public.profiles(id) on delete cascade,
  care_enabled   boolean not null default true,
  per_character  jsonb not null default '{}'::jsonb,   -- { character_id: false }
  hide_content   boolean not null default false,       -- 锁屏只显示"有新消息"
  updated_at     timestamptz not null default now()
);
alter table public.notify_prefs enable row level security;
drop policy if exists p_prefs_own on public.notify_prefs;
create policy p_prefs_own on public.notify_prefs
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ─── 公告 ────────────────────────────────────────────────
create table if not exists public.announcements (
  id          bigint generated always as identity primary key,
  slug        citext unique not null,
  title       text not null,
  body        text not null default '',
  kind        text not null default 'info' check (kind in ('info','maintenance','billing','legal')),
  published   boolean not null default false,
  starts_at   timestamptz not null default now(),
  ends_at     timestamptz,
  created_at  timestamptz not null default now()
);
alter table public.announcements enable row level security;
drop policy if exists p_ann_read on public.announcements;
create policy p_ann_read on public.announcements
  for select to authenticated, anon using (published and starts_at <= now()
    and (ends_at is null or ends_at > now()));

-- ─── 内容处理规则库（后台可维护，不需发版）───────────────
create table if not exists public.sensitive_rules (
  id          bigint generated always as identity primary key,
  pattern     text not null,                 -- 正则源串，不含 / 包裹
  flags       text not null default 'i',
  scope       text not null default 'community'
                check (scope in ('community','proactive','all')),
  action      text not null default 'block'
                check (action in ('block','replace','flag','review')),
  reason      text not null default '',      -- 给用户看的可解释理由
  enabled     boolean not null default true,
  hits        int not null default 0,
  updated_by  text not null default 'system',
  updated_at  timestamptz not null default now(),
  unique (pattern, scope)
);
alter table public.sensitive_rules enable row level security;
-- 规则本身对用户不可见（否则等于把绕过方法公开）

-- 内存缓存版本号：Edge Function 据此决定要不要重载规则
create table if not exists public.rule_version (
  id int primary key default 1 check (id = 1),
  v bigint not null default 1,
  updated_at timestamptz not null default now()
);
insert into public.rule_version (id) values (1) on conflict (id) do nothing;

create or replace function public.bump_rule_version()
returns trigger language plpgsql set search_path = pg_catalog, public as $fn$
begin
  update public.rule_version set v = v + 1, updated_at = now() where id = 1;
  return new;
end;
$fn$;

drop trigger if exists trg_rule_bump on public.sensitive_rules;
create trigger trg_rule_bump after insert or update or delete on public.sensitive_rules
  for each statement execute function public.bump_rule_version();

-- ─── 分享链接（增长归因的唯一可靠手段）───────────────────
create table if not exists public.share_links (
  id           text primary key,             -- 短码
  user_id      uuid references public.profiles(id) on delete set null,
  character_id uuid references public.characters(id) on delete set null,
  session_id   uuid references public.sessions(id) on delete set null,
  messages     uuid[] not null default '{}', -- 被公开的那几条（用户主动选的）
  image_path   text,
  visibility   text not null default 'public' check (visibility in ('unlisted','public')),
  views        int not null default 0,
  signups      int not null default 0,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz
);
create index if not exists idx_share_char on public.share_links(character_id);

alter table public.share_links enable row level security;
drop policy if exists p_share_read on public.share_links;
create policy p_share_read on public.share_links
  for select to authenticated, anon
  using (visibility = 'public' and (expires_at is null or expires_at > now()));
-- 写入只能经 Edge Function（要校验消息属于本人且被本人显式选中）

create table if not exists public.share_visits (
  id          bigint generated always as identity primary key,
  link_id     text not null references public.share_links(id) on delete cascade,
  referrer    text not null default '',
  ua_class    text not null default '',
  converted   boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists idx_visit_link on public.share_visits(link_id, created_at desc);
alter table public.share_visits enable row level security;

-- ─── 创作者收益记账（平台不碰资金池，只记账）─────────────
create table if not exists public.card_listings (
  character_id   uuid primary key references public.characters(id) on delete cascade,
  creator_id     uuid not null references public.profiles(id) on delete cascade,
  price_cny      numeric(12,2) not null check (price_cny > 0),
  platform_rate  numeric(4,3) not null default 0.300,
  status         text not null default 'pending'
                   check (status in ('pending','approved','rejected','delisted')),
  sales          int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
alter table public.card_listings enable row level security;
drop policy if exists p_listing_read on public.card_listings;
create policy p_listing_read on public.card_listings
  for select to authenticated using (status = 'approved');

create table if not exists public.card_purchases (
  id             uuid primary key default gen_random_uuid(),
  character_id   uuid not null references public.characters(id) on delete restrict,
  buyer_id       uuid not null references public.profiles(id) on delete cascade,
  creator_id     uuid not null references public.profiles(id) on delete cascade,
  price_cny      numeric(12,2) not null,
  platform_cut   numeric(12,2) not null,
  creator_cut    numeric(12,2) not null,
  order_ref      text unique,
  status         text not null default 'paid' check (status in ('paid','refunded')),
  created_at     timestamptz not null default now(),
  unique (character_id, buyer_id)
);
alter table public.card_purchases enable row level security;
drop policy if exists p_purchase_own on public.card_purchases;
create policy p_purchase_own on public.card_purchases
  for select to authenticated using (buyer_id = auth.uid() or creator_id = auth.uid());

-- 已购即可永久使用，不受创作者注销影响（07 号专篇 §6.2）
create table if not exists public.creator_earnings (
  creator_id     uuid not null references public.profiles(id) on delete cascade,
  period         text not null,              -- 'YYYY-MM'
  gross_cny      numeric(12,2) not null default 0,
  platform_cny   numeric(12,2) not null default 0,
  net_cny        numeric(12,2) not null default 0,
  sales          int not null default 0,
  settled_at     timestamptz,
  payout_ref     text,
  primary key (creator_id, period)
);
alter table public.creator_earnings enable row level security;
drop policy if exists p_earn_own on public.creator_earnings;
create policy p_earn_own on public.creator_earnings
  for select to authenticated using (creator_id = auth.uid());

-- ─── 角色卡审核（25 号专篇：默认需审核）──────────────────
alter table public.card_reviews add column if not exists reviewer text not null default 'auto';
alter table public.card_reviews add column if not exists detail jsonb not null default '{}'::jsonb;

-- ─── 会话置顶与归档排序 ─────────────────────────────────
alter table public.sessions add column if not exists pinned_at timestamptz;
alter table public.sessions add column if not exists unread_base int not null default 0;

-- ─── 记忆：允许用户给记忆打标签与手动新增 ────────────────
alter table public.memories add column if not exists manual boolean not null default false;
alter table public.memories add column if not exists note text not null default '';

-- ─── 自检 ───────────────────────────────────────────────
-- 执行后各列必须为 true
select
  (select count(*) from pg_catalog.pg_tables where schemaname='public'
     and tablename in ('proactive_jobs','push_devices','notify_prefs','announcements',
       'sensitive_rules','rule_version','share_links','share_visits',
       'card_listings','card_purchases','creator_earnings')) = 11          as tables_ok,
  (select count(*) from pg_catalog.pg_indexes i
     where i.tablename in ('proactive_jobs','push_devices','share_links','card_purchases')) >= 6
                                                                           as indexes_ok,
  (select v from public.rule_version where id = 1) >= 1                    as rule_version_ok,
  (select count(*) from pg_catalog.pg_policies p
     join pg_catalog.pg_class c on c.oid = p.tablename::regclass
    where p.schemaname='public' and p.policyname like 'p_%') >= 8          as policies_ok,
  (select relrowsecurity from pg_class where oid='public.proactive_jobs'::regclass) = true
                                                                           as jobs_rls_on,
  (select count(*) from pg_catalog.pg_policies
     where schemaname='public' and tablename='sensitive_rules') = 0        as rules_hidden_from_users;
