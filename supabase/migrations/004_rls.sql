-- 004_rls.sql
-- 行级安全策略。核心目标：
--   1) 用户只能读写自己的数据
--   2) character_locks / affinity_state / character_versions 对用户侧零读
--      —— 这是 C8「用户绝对看不到隐藏 prompt」的数据库层兜底
--   3) ledger 对用户只读，写入只能经 Edge Function（service_role 绕过 RLS）
-- 见 docs/分册-后端与数据库.md §5、docs/验收清单.md V1-1…V1-5

-- ─── 前置：角色审核状态（002 未建，此处补列避免前向依赖）──
alter table public.characters
  add column if not exists review_status text not null default 'none'
    check (review_status in ('none','pending','approved','rejected'));

create table if not exists public.card_reviews (
  character_id uuid primary key references public.characters(id) on delete cascade,
  status       text not null check (status in ('pending','approved','rejected')),
  reason       text,
  reviewed_at  timestamptz not null default now()
);

-- ─── 启用 RLS ────────────────────────────────────────────
alter table public.profiles           enable row level security;
alter table public.entitlements       enable row level security;
alter table public.balances           enable row level security;
alter table public.ledger             enable row level security;
alter table public.characters         enable row level security;
alter table public.character_versions enable row level security;
alter table public.character_locks    enable row level security;
alter table public.sessions           enable row level security;
alter table public.session_members    enable row level security;
alter table public.messages           enable row level security;
alter table public.plan_catalog       enable row level security;
alter table public.card_reviews       enable row level security;

-- 幂等：先清同名策略
do $do$
declare p record;
begin
  for p in
    select schemaname, tablename, policyname
      from pg_catalog.pg_policies
     where schemaname = 'public'
       and policyname like 'p_%'
  loop
    execute format('drop policy if exists %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
end
$do$;

-- ─── 1. 自己的数据：可读 ─────────────────────────────────
create policy p_profiles_read on public.profiles
  for select to authenticated using (id = auth.uid());

-- 昵称/头像/设置可自行修改；afdian_user_id 与 birth_declared 只能由服务端写
create policy p_profiles_write on public.profiles
  for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy p_entitlements_read on public.entitlements
  for select to authenticated using (user_id = auth.uid());

create policy p_balances_read on public.balances
  for select to authenticated using (user_id = auth.uid());

create policy p_sessions_rw on public.sessions
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy p_members_via_session on public.session_members
  for all to authenticated
  using (exists (select 1 from public.sessions s
                  where s.id = session_id and s.user_id = auth.uid()))
  with check (exists (select 1 from public.sessions s
                       where s.id = session_id and s.user_id = auth.uid()));

-- 消息：可读、可插；★不给 update/delete（删除走受控 RPC，见 09 号专篇 §7）
create policy p_messages_read on public.messages
  for select to authenticated using (user_id = auth.uid());

create policy p_messages_insert on public.messages
  for insert to authenticated with check (user_id = auth.uid());

-- 账本：只读。无 insert/update/delete 策略 ⇒ authenticated 无法写
create policy p_ledger_read on public.ledger
  for select to authenticated using (user_id = auth.uid());

-- ─── 2. ★零读：隐藏锁 / 内层好感度 / 人设版本 ────────────
-- 显式写 using(false) 是为了让意图在 pg_policies 里可见，
-- 而不是依赖"没建策略所以默认拒绝"这种隐式行为。
create policy p_locks_deny on public.character_locks
  for select to authenticated using (false);

create policy p_versions_deny on public.character_versions
  for select to authenticated using (false);

-- affinity_state 在 005 建，此处对已存在的表按需处理
do $do$
begin
  if exists (select 1 from pg_catalog.pg_tables
              where schemaname='public' and tablename='affinity_state') then
    execute 'alter table public.affinity_state enable row level security';
    execute $q$create policy p_affinity_deny on public.affinity_state
                 for select to authenticated using (false)$q$;
  end if;
end
$do$;

-- ─── 3. 角色可见性 ───────────────────────────────────────
create policy p_characters_read on public.characters
  for select to authenticated using (
    owner_id = auth.uid()
    or owner_id is null                                   -- 官方角色
    or (visibility = 'public' and review_status = 'approved')
  );

create policy p_characters_write on public.characters
  for insert to authenticated with check (owner_id = auth.uid());

create policy p_characters_update on public.characters
  for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy p_characters_delete on public.characters
  for delete to authenticated using (owner_id = auth.uid());

-- 商品目录：登录用户可读启用项（价格页要用）
create policy p_catalog_read on public.plan_catalog
  for select to authenticated using (active = true);

create policy p_reviews_read on public.card_reviews
  for select to authenticated using (
    exists (select 1 from public.characters c
             where c.id = card_reviews.character_id and c.owner_id = auth.uid())
  );

-- ─── 4. 关系阶段可读（外层可见），内层见 §2 ──────────────
do $do$
begin
  if exists (select 1 from pg_catalog.pg_tables
              where schemaname='public' and tablename='relationship_stage') then
    execute 'alter table public.relationship_stage enable row level security';
    execute $q$create policy p_stage_read on public.relationship_stage
                 for select to authenticated using (
                   exists (select 1 from public.sessions s
                            where s.id = relationship_stage.session_id
                              and s.user_id = auth.uid())
                 )$q$;
  end if;
end
$do$;

-- ─── 5. 防提权：security definer 函数必须锁 search_path ──
-- check-sql.mjs 已在 CI 静态校验；此处做运行时兜底核查
create or replace function public.audit_definer_search_path()
returns jsonb language sql stable set search_path = pg_catalog, public as $fn$
  select jsonb_build_object(
    'definer_without_search_path',
    (select count(*) from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prosecdef
        and p.proconfig is null)
  );
$fn$;

-- ─── 自检 ───────────────────────────────────────────────
select
  (select count(*) from pg_catalog.pg_policies
     where schemaname='public' and policyname like 'p_%') >= 14      as policies_ok,
  (select count(*) from pg_catalog.pg_class c
     join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname::text in ('character_locks','character_versions','ledger','messages','profiles')
      and c.relrowsecurity) = 5                                         as rls_enabled_ok,
  (select count(*) from pg_catalog.pg_policies
     where schemaname='public' and tablename='character_locks') = 1  as locks_policy_present,
  (select count(*) from pg_catalog.pg_policies
     where schemaname='public' and tablename='ledger'
       and cmd <> 'SELECT') = 0                                      as ledger_write_denied,
  (select count(*) from pg_catalog.pg_policies
     where schemaname='public' and tablename='messages'
       and cmd in ('UPDATE','DELETE')) = 0                           as msg_update_delete_denied,
  (public.audit_definer_search_path() ->> 'definer_without_search_path')::int = 0
                                                                     as no_unsafe_definer;
