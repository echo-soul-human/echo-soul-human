-- 009_derived_flags.sql
-- 把"派生权限位"落到库里，让 SQL 侧与 Edge Function 侧共用同一个真源。
--
-- 背景：can_publish / is_minor 原本只在服务端 limits.ts 里按 tier 与生日推导，
-- 但 publish_character 等 SQL 函数也需要判 —— 两边各推一遍迟早分叉。
-- 实测已经踩到：SQL 里 select can_publish from entitlements 直接 42703。
-- 幂等：可重复执行。

-- ─── 1. can_publish：由 tier 决定的存储生成列 ───────────
-- 生成列不能 UPDATE，从根上杜绝"手滑改权限位"
alter table public.entitlements drop column if exists can_publish cascade;
alter table public.entitlements
  add column can_publish boolean generated always as (
    tier in ('pro','pro_plus','ultra')
  ) stored;

-- ─── 2. is_minor：由 profiles.birth_declared 同步 ────────
alter table public.entitlements
  add column if not exists is_minor boolean not null default false;

create or replace function public.sync_is_minor()
returns trigger language plpgsql volatile set search_path = pg_catalog, public as $fn$
declare v_minor boolean;
begin
  -- 满 18 才算成年人；生日缺失按成年人（前端会要求补声明）
  v_minor := case
    when new.birth_declared is null then false
    when new.birth_declared >= date_trunc('year', now()) - interval '18 year' then true
    else false end;

  update public.entitlements set is_minor = v_minor where user_id = new.id;
  return new;
end;
$fn$;

drop trigger if exists trg_sync_is_minor on public.profiles;
create trigger trg_sync_is_minor
  after insert or update of birth_declared on public.profiles
  for each row execute function public.sync_is_minor();

-- 存量回填
update public.profiles set birth_declared = birth_declared where birth_declared is not null;

-- ─── 3. 权益快照补齐：把所有限制位集中到一张视图 ─────────
-- Edge Function 与后台都读这个视图，避免各处重复 select 一堆列
create or replace view public.effective_entitlements as
  select
    e.user_id,
    -- 过期即视为 free，但已消耗与已存数据一律保留（17 号专篇 §4.5）
    case when e.expires_at is not null and e.expires_at < now() then 'free'::public.tier_t
         else e.tier end as effective_tier,
    e.tier as purchased_tier,
    e.expires_at, e.credit_expiry,
    case when e.expires_at is not null and e.expires_at < now() then 1
         else e.character_slots end   as character_slots,
    case when e.expires_at is not null and e.expires_at < now() then 262144
         else e.window_limit end      as window_limit,
    case when e.expires_at is not null and e.expires_at < now() then 8192
         else e.carry_tokens end      as carry_tokens,
    case when e.expires_at is not null and e.expires_at < now() then 8192
         else e.carry_default end     as carry_default,
    case when e.expires_at is not null and e.expires_at < now() then 4
         else e.recall_topk end       as recall_topk,
    case when e.expires_at is not null and e.expires_at < now() then 2
         else e.group_member_max end  as group_member_max,
    case when e.expires_at is not null and e.expires_at < now() then 1
         else e.skin_quota end        as skin_quota,
    case when e.expires_at is not null and e.expires_at < now() then 20
         else e.sticker_quota end     as sticker_quota,
    case when e.expires_at is not null and e.expires_at < now() then 0
         else e.proactive_per_day end as proactive_per_day,
    e.can_publish,
    e.is_minor,
    (e.expires_at is not null and e.expires_at < now()) as lapsed
  from public.entitlements e;

-- ─── 4. 社区：帖子 / 评论 / 反应 / 举报 ──────────────────
create table if not exists public.posts (
  id            uuid primary key default gen_random_uuid(),
  author_id     uuid not null references public.profiles(id) on delete cascade,
  character_id  uuid references public.characters(id) on delete set null,
  kind          text not null default 'card' check (kind in ('card','share','discussion')),
  title         text not null default '',
  body          text not null default '',
  image_path    text,
  visibility    text not null default 'public'
                  check (visibility in ('private','unlisted','public')),
  review_status text not null default 'pending'
                  check (review_status in ('pending','approved','rejected','hidden')),
  reject_reason text not null default '',
  tags          text[] not null default '{}',
  deleted_by_user_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_posts_public on public.posts(created_at desc)
  where visibility = 'public' and review_status = 'approved';
create index if not exists idx_posts_char on public.posts(character_id);
create index if not exists idx_posts_tags on public.posts using gin(tags);

create table if not exists public.post_comments (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references public.posts(id) on delete cascade,
  author_id   uuid not null references public.profiles(id) on delete cascade,
  parent_id   uuid references public.post_comments(id) on delete cascade,
  body        text not null,
  review_status text not null default 'approved'
                  check (review_status in ('pending','approved','rejected','hidden')),
  created_at  timestamptz not null default now()
);
create index if not exists idx_comments_post on public.post_comments(post_id, created_at);

create table if not exists public.post_reactions (
  post_id    uuid not null references public.posts(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  kind       text not null default 'like' check (kind in ('like','save')),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id, kind)
);

create table if not exists public.reports (
  id          bigint generated always as identity primary key,
  target_kind text not null check (target_kind in ('post','comment','character','user','share')),
  target_id   text not null,
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reason      text not null check (length(reason) between 2 and 500),
  category    text not null default 'other'
                check (category in ('illegal','minor_sexual','self_harm','harassment',
                                    'copyright','impersonation','spam','scam','privacy','other')),
  status      text not null default 'open'
                check (status in ('open','actioned','dismissed','auto_hidden')),
  auto_hidden boolean not null default false,
  decided_by  text not null default '',
  decided_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists idx_report_target on public.reports(target_kind, target_id, status);
create unique index if not exists uq_report_once on public.reports(target_kind, target_id, reporter_id);

-- 举报达阈值自动隐藏（不是删除，可恢复）——25 号专篇 §4.1
alter table public.posts  add column if not exists report_count int not null default 0;
alter table public.post_comments add column if not exists report_count int not null default 0;

create or replace function public.auto_hide_on_threshold()
returns trigger language plpgsql volatile set search_path = pg_catalog, public as $fn$
declare v_n int; v_th int := 3;
begin
  if new.category in ('minor_sexual','self_harm','scam','impersonation') then
    v_th := 1;   -- 高危类别一次举报即隐藏
  end if;

  update public.posts
     set report_count = report_count + 1
   where new.target_kind = 'post' and id::text = new.target_id
     and report_count < 1000
   returning report_count into v_n;

  if new.target_kind = 'post' and v_n >= v_th then
    update public.posts set review_status = 'hidden'
     where id::text = new.target_id and review_status <> 'hidden';
    update public.reports set status = 'auto_hidden', auto_hidden = true
     where id = new.id;
  end if;

  update public.post_comments
     set report_count = report_count + 1
   where new.target_kind = 'comment' and id::text = new.target_id
     and report_count < 1000
   returning report_count into v_n;

  if new.target_kind = 'comment' and v_n >= v_th then
    update public.post_comments set review_status = 'hidden'
     where id::text = new.target_id and review_status <> 'hidden';
    update public.reports set status = 'auto_hidden', auto_hidden = true
     where id = new.id;
  end if;

  return new;
end;
$fn$;

drop trigger if exists trg_auto_hide on public.reports;
create trigger trg_auto_hide after insert on public.reports
  for each row execute function public.auto_hide_on_threshold();

-- ─── 社区 RLS ──────────────────────────────────────────
alter table public.posts enable row level security;
alter table public.post_comments enable row level security;
alter table public.post_reactions enable row level security;
alter table public.reports enable row level security;

drop policy if exists p_posts_read on public.posts;
create policy p_posts_read on public.posts for select to authenticated using (
  author_id = auth.uid()
  or (visibility = 'public' and review_status = 'approved' and deleted_by_user_at is null)
);
drop policy if exists p_posts_write on public.posts;
create policy p_posts_write on public.posts for insert to authenticated
  with check (author_id = auth.uid());
drop policy if exists p_posts_own on public.posts;
create policy p_posts_own on public.posts for update to authenticated
  using (author_id = auth.uid()) with check (author_id = auth.uid());
drop policy if exists p_posts_del on public.posts;
create policy p_posts_del on public.posts for delete to authenticated
  using (author_id = auth.uid());

drop policy if exists p_comments_read on public.post_comments;
create policy p_comments_read on public.post_comments for select to authenticated using (
  author_id = auth.uid()
  or (review_status = 'approved' and exists (
        select 1 from public.posts p
         where p.id = post_comments.post_id
           and p.visibility = 'public' and p.review_status in ('approved','hidden')))
);
drop policy if exists p_comments_write on public.post_comments;
create policy p_comments_write on public.post_comments for insert to authenticated
  with check (author_id = auth.uid() and length(body) between 1 and 2000);
drop policy if exists p_comments_own on public.post_comments;
create policy p_comments_own on public.post_comments for delete to authenticated
  using (author_id = auth.uid());

drop policy if exists p_react_own on public.post_reactions;
create policy p_react_own on public.post_reactions
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 举报：只能自己提，看不到别人提了什么（保护举报人，25 号专篇 §3.3）
drop policy if exists p_reports_insert on public.reports;
create policy p_reports_insert on public.reports for insert to authenticated
  with check (reporter_id = auth.uid());
drop policy if exists p_reports_own_read on public.reports;
create policy p_reports_own_read on public.reports for select to authenticated
  using (reporter_id = auth.uid());

-- ─── 分享落地页所需的受控读取 ───────────────────────────
-- 只暴露被显式勾选分享的消息，且必须来自已批准的分享链接
create or replace function public.share_messages(p_code text)
returns table (role msg_role, content text, created_at timestamptz)
language sql stable security definer set search_path = pg_catalog, public as $fn$
  select m.role, left(m.content, 600), m.created_at
    from public.share_links sl
    join public.messages m on m.id = any (sl.messages)
   where sl.id = p_code
     and sl.visibility = 'public'
     and (sl.expires_at is null or sl.expires_at > now())
   order by m.created_at;
$fn$;
grant execute on function public.share_messages(text) to anon, authenticated;

-- ─── 后台：运营与审计视图 ──────────────────────────────
create or replace view public.admin_order_reconcile as
  select o.id, o.external_id, o.amount_cny, o.status as order_status,
         pc.tier, pc.price_cny, pc.grant_credit,
         l.id as ledger_id, l.type as ledger_type, l.amount as ledger_amount,
         (o.status = 'granted' and l.id is null)     as missing_grant,
         (o.status = 'granted' and l.amount is distinct from pc.grant_credit) as amount_mismatch
    from public.orders o
    left join public.plan_catalog pc on pc.id = o.plan_ref
    left join public.ledger l
      on l.ref_kind = 'order' and l.ref_id = o.external_id and l.type = 'purchase';

create or replace view public.admin_daily_cost as
  select date_trunc('day', created_at) as day,
         e.tier,
         count(distinct l.user_id) as users,
         coalesce(sum(l.amount) filter (where l.type = 'settle'), 0) as revenue_credit,
         coalesce(sum((l.model_usage->>'cost_actual')::numeric), 0) as model_cost
    from public.ledger l
    join public.entitlements e on e.user_id = l.user_id
   where l.type in ('settle','grant','purchase')
   group by 1, 2;

create or replace view public.admin_rule_effectiveness as
  select id, scope, action, reason, hits, enabled, updated_at
    from public.sensitive_rules
   order by hits desc;

-- 后台表一律不开给前端角色
revoke all on public.admin_order_reconcile from anon, authenticated;
revoke all on public.admin_daily_cost from anon, authenticated;
revoke all on public.admin_rule_effectiveness from anon, authenticated;
revoke all on public.reports from anon;

-- ─── 自检 ───────────────────────────────────────────────
select
  (select count(*) from information_schema.columns
     where table_schema='public' and table_name='entitlements'
       and column_name in ('can_publish','is_minor')) = 2                   as flags_ok,
  (select is_generated from information_schema.columns
     where table_schema='public' and table_name='entitlements'
       and column_name='can_publish') = 'ALWAYS'                            as can_publish_generated,
  (select count(*) from pg_catalog.pg_views where schemaname='public'
     and viewname in ('effective_entitlements','admin_order_reconcile',
                      'admin_daily_cost','admin_rule_effectiveness')) = 4   as views_ok,
  (select count(*) from pg_catalog.pg_tables where schemaname='public'
     and tablename in ('posts','post_comments','post_reactions','reports')) = 4 as community_tables_ok,
  (select count(*) from pg_catalog.pg_trigger t
     join pg_catalog.pg_class c on c.oid=t.tgrelid
    where c.relname='reports' and t.tgname='trg_auto_hide' and not t.tgisinternal) = 1
                                                                            as auto_hide_trigger_ok,
  (select count(*) from pg_catalog.pg_policies p
     where p.schemaname='public' and p.tablename in ('posts','post_comments','post_reactions','reports')
  ) >= 9                                                                    as community_policies_ok,
  (select has_table_privilege('authenticated','public.admin_order_reconcile','select')) = false
                                                                            as admin_views_locked;
