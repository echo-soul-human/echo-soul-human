-- 006_billing_tables.sql
-- 订单、未匹配订单、BYOK 凭据档案、后台审计
-- 见 docs/分册-模型与计费.md §4.3、§5；docs/分册-后端与数据库.md §3.1

-- ─── 订单落地 ────────────────────────────────────────────
create table if not exists public.orders (
  id              uuid primary key default gen_random_uuid(),
  external_id     text not null unique,          -- 爱发电 out_trade_no（幂等真源）
  user_id         uuid references public.profiles(id) on delete set null,
  afdian_user_id  text not null,
  plan_ref        text references public.plan_catalog(id),
  afdian_plan_id  text not null default '',
  amount_cny      numeric(12,2) not null default 0,
  show_amount_cny numeric(12,2) not null default 0,
  product_type    int not null default 0,        -- 0 订阅 · 1 售卖
  order_status    int not null default 2,        -- 2 交易成功
  remark          text not null default '',
  custom_order_id text not null default '',
  source          text not null default 'webhook' check (source in ('webhook','poll','manual')),
  status          text not null default 'pending'
                    check (status in ('pending','granted','failed','refunded')),
  granted_at      timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists idx_orders_user on public.orders(user_id, created_at desc);
create index if not exists idx_orders_afdian on public.orders(afdian_user_id);
create index if not exists idx_orders_status on public.orders(status) where status <> 'granted';

-- 用户可见的"到账历史"走视图，避免把 afdian_user_id 等内部字段暴露出去
create or replace view public.order_history as
  select o.id, o.user_id, o.plan_ref, pc.tier, pc.is_addon,
         o.amount_cny, o.status, o.granted_at, o.created_at
    from public.orders o
    left join public.plan_catalog pc on pc.id = o.plan_ref
   where o.user_id is not null;

-- ─── 未匹配订单（仅后台可见，不打扰用户，17 号专篇 §7）────
create table if not exists public.unmatched_orders (
  external_id     text primary key,
  afdian_user_id  text not null,
  afdian_plan_id  text not null default '',
  amount_cny      numeric(12,2) not null default 0,
  reason          text not null default 'unknown',
  source          text not null default 'webhook',
  resolved        boolean not null default false,
  resolved_at     timestamptz,
  attempts        int not null default 0,
  raw             jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_unmatched_open on public.unmatched_orders(created_at)
  where resolved = false;

alter table public.unmatched_orders enable row level security;
-- 没有任何 policy ⇒ authenticated 完全不可见（不通知用户、不引导客服）

-- ─── BYOK：元数据表（authenticated 可按 RLS 读，不含任何密文）──
create table if not exists public.byok_profiles (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  kind         text not null check (kind in ('openai','anthropic')),
  label        text not null default '',
  base_url     text not null,
  model        text not null default '',
  key_mask     text not null,          -- ****abcd，唯一可回前端的形态
  extra_body   jsonb not null default '{}'::jsonb,
  enabled      boolean not null default true,
  last_used_at timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists idx_byok_user on public.byok_profiles(user_id);

-- ─── BYOK：密文表（★对 authenticated / anon 零授权）────────
-- 为什么不靠列级 REVOKE：Supabase 通过 default privileges 授予 authenticated
-- **表级** SELECT，而 Postgres 的列级 REVOKE 无法从表级授权中减除列权限，
-- 结果登录用户仍能把自己那行的密文 blob 整份拖走。
-- 唯一可靠做法是把密文放进一张从未授权给任何前端角色的表，只有
-- service_role（Edge Function 使用，绕过 RLS）能读写。
create table if not exists public.byok_secrets (
  profile_id   uuid primary key references public.byok_profiles(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  wrapped_dk   text not null,
  dk_iv        text not null,
  ciphertext   text not null,
  iv           text not null,
  created_at   timestamptz not null default now()
);
create index if not exists idx_byoksec_user on public.byok_secrets(user_id);

alter table public.byok_profiles enable row level security;
alter table public.byok_secrets  enable row level security;

-- 元数据表：只读自己的行；写入一律拒绝（只能经 Edge Function）
drop policy if exists p_byok_read on public.byok_profiles;
create policy p_byok_read on public.byok_profiles
  for select to authenticated using (user_id = auth.uid());
drop policy if exists p_byok_nowrite on public.byok_profiles;
create policy p_byok_nowrite on public.byok_profiles
  for insert to authenticated with check (false);
drop policy if exists p_byok_noupd on public.byok_profiles;
create policy p_byok_noupd on public.byok_profiles
  for update to authenticated using (false);
drop policy if exists p_byok_nodel on public.byok_profiles;
create policy p_byok_nodel on public.byok_profiles
  for delete to authenticated using (false);

-- ★ 密文表：定点撤销一切授权，且不建任何 policy（RLS 默认拒绝）
-- 刻意**不用** `alter default privileges ... revoke all on tables from authenticated`：
-- 那会让今后 public schema 下每张新表都静默失去前端授权，属于延迟爆发的雷。
-- 今后新增敏感表请沿用本模式：建表 → 立刻 revoke → 不开 policy。
revoke all on public.byok_secrets from authenticated, anon;

-- 兼容旧结构：若密文列还挂在 byok_profiles 上，迁移后删除
do $do$
begin
  if exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='byok_profiles'
                and column_name='enc_key') then
    insert into public.byok_secrets (profile_id, user_id, wrapped_dk, dk_iv, ciphertext, iv)
      select id, user_id, wrapped_dk, dk_iv, enc_key, enc_iv from public.byok_profiles
      on conflict (profile_id) do nothing;
    alter table public.byok_profiles drop column if exists wrapped_dk;
    alter table public.byok_profiles drop column if exists dk_iv;
    alter table public.byok_profiles drop column if exists enc_key;
    alter table public.byok_profiles drop column if exists enc_iv;
  end if;
end
$do$;

-- 前端读这个视图即可（表内本就无密文）
create or replace view public.byok_profiles_public with (security_invoker = true) as
  select id, user_id, kind, label, base_url, model, key_mask, enabled, last_used_at, created_at
    from public.byok_profiles;

-- ─── 后台审计（09/25/30 号专篇要求的留痕）────────────────
create table if not exists public.admin_audit (
  id         bigint generated always as identity primary key,
  actor      text not null default 'system',
  action     text not null,
  target     text not null default '',
  detail     text not null default '',
  created_at timestamptz not null default now()
);
alter table public.admin_audit enable row level security;
-- 无 policy ⇒ 用户不可读写，仅 service_role 可见

-- ─── 用户侧自助入口（17 号专篇 §7：不找客服）─────────────
-- "我付了但没到账"：用户报订单号，服务端触发一次定向归因
create or replace function public.claim_order(p_out_trade_no text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $fn$
declare
  v_uid uuid; v_row record; v_found boolean := false;
begin
  v_uid := auth.uid();
  if v_uid is null then return jsonb_build_object('ok', false, 'code', 'UNAUTHORIZED'); end if;
  if p_out_trade_no is null or length(trim(p_out_trade_no)) < 8 then
    return jsonb_build_object('ok', false, 'code', 'BAD_ORDER_NO');
  end if;

  -- 限频：同一用户 3 次/分钟，防被用来枚举他人订单号
  if (select count(*) from public.admin_audit
        where actor = v_uid::text and action = 'claim_order'
          and created_at > now() - interval '1 minute') >= 3 then
    return jsonb_build_object('ok', false, 'code', 'RATE_LIMITED');
  end if;
  insert into public.admin_audit (actor, action, target, detail)
    values (v_uid::text, 'claim_order', p_out_trade_no, '自助重查');

  select into v_row * from public.unmatched_orders
    where external_id = trim(p_out_trade_no) and resolved = false;
  if found then
    -- 把该单的 afdian_user_id 绑到当前用户（L1 建立的兜底路径）
    update public.profiles set afdian_user_id = v_row.afdian_user_id
      where id = v_uid and afdian_user_id is null;
    update public.unmatched_orders set attempts = attempts + 1
      where external_id = v_row.external_id;
    v_found := true;
  end if;

  return jsonb_build_object(
    'ok', true,
    'matched', v_found,
    'note', case when v_found then '已提交重查，2 分钟内到账' else '未找到该订单，请确认订单号或稍后再试' end
  );
end;
$fn$;

grant execute on function public.claim_order(text) to authenticated;

-- 到账状态自查（17 号专篇 §6.1）
create or replace function public.my_credit()
returns jsonb language sql stable security definer set search_path = pg_catalog, public as $fn$
  select jsonb_build_object(
    'tier', e.tier,
    'expires_at', e.expires_at,
    'credit_expiry', e.credit_expiry,
    'usable', coalesce(b.usable, 0),
    'frozen', coalesce(b.frozen, 0),
    'granted', coalesce(b.granted, 0),
    'spent', coalesce(b.spent, 0),
    'tts_remaining', coalesce(b.tts_granted,0) - coalesce(b.tts_spent,0)
  )
  from public.entitlements e
  left join public.balances b on b.user_id = e.user_id
  where e.user_id = auth.uid();
$fn$;

grant execute on function public.my_credit() to authenticated;

-- ─── 自检 ───────────────────────────────────────────────
select
  (select count(*) from pg_catalog.pg_tables where schemaname='public'
     and tablename in ('orders','unmatched_orders','byok_profiles','admin_audit')) = 4
                                                                          as tables_ok,
  (select count(*) from pg_catalog.pg_views where schemaname='public'
     and viewname in ('order_history','byok_profiles_public')) = 2        as views_ok,
  -- ★ 密文表必须对前端角色零授权（列级 REVOKE 挡不住表级授权，故拆表）
  (select not has_table_privilege('authenticated'::regrole, 'public.byok_secrets'::regclass, 'select')
       and not has_table_privilege('anon'::regrole,         'public.byok_secrets'::regclass, 'select')
  )                                                                        as secrets_table_locked,
  -- 元数据表不得残留任何密文列
  (select count(*) from information_schema.columns
     where table_schema='public' and table_name='byok_profiles'
       and column_name in ('wrapped_dk','dk_iv','enc_key','enc_iv','ciphertext')) = 0
                                                                           as metadata_clean,
  (select count(*) from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('claim_order','my_credit')
      and p.prosecdef
      and p.proconfig is not null
      and exists (select 1 from unnest(p.proconfig) as cfg where cfg like 'search_path=%')) = 2
                                                                          as definer_guarded_ok,
  (select count(*) from pg_catalog.pg_indexes where tablename='orders'
     and indexname like '%external_id%') >= 1                             as order_idempotency_ok;
