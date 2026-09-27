-- 010_account_lifecycle.sql
-- 修一个真实的越权缺陷 + 补齐注销/导出/审核 RPC
--
-- ★ 缺陷：characters.owner_id 的外键原本是 `on delete set null`，
--   而 004 的 RLS 把 `owner_id is null` 判为"官方角色"。
--   后果：用户注销后，他自建的角色会**自动变成官方角色**并对所有人可见。
--   这不是理论问题 —— 写 verify-rpc 的清理段时推演出来的。
-- 幂等：可重复执行。

-- ─── 1. 外键改为级联删除 ─────────────────────────────────
-- 09 号专篇 §5.1 本来就要求"自建角色及其人设、立绘、配置 → 行删除"
alter table public.characters drop constraint if exists characters_owner_id_fkey;
alter table public.characters
  add constraint characters_owner_id_fkey
  foreign key (owner_id) references public.profiles(id) on delete cascade;

-- 已经存在的"被降级成官方"的孤儿角色无法还原归属，直接清掉。
-- 只在 owner 曾经存在过的自建角色里清：官方角色创建时 owner_id 一直是 null，
-- 但它们的 slug 由运营方控制，不带用户级随机后缀，这里用 review_status 兜底判断。
delete from public.characters
 where owner_id is null
   and review_status <> 'approved'
   and coalesce(visibility,'private') <> 'public';

-- 防复发：官方角色必须是显式批准的
alter table public.characters drop constraint if exists ck_official_approved;
alter table public.characters add constraint ck_official_approved
  check (owner_id is not null or review_status = 'approved');

-- ─── 2. 账号注销：真正的硬删除 + 财务凭证匿名化 ─────────
-- 09 号专篇 §5/§6 的实现。ledger 不能删（append-only 守卫），改为匿名化。
create or replace function public.hash_for_retention(p_user uuid)
returns uuid language sql immutable set search_path = pg_catalog, public as $fn$
  -- 用固定盐做单向哈希：同一用户多次调用结果一致，但无法反查到人
  select md5('echosoul-retention-v1' || p_user::text)::uuid;
$fn$;
revoke execute on function public.hash_for_retention(uuid) from public, anon, authenticated;

alter table public.ledger drop constraint if exists fk_ledger_user;
alter table public.ledger
  add constraint fk_ledger_user
  foreign key (user_id) references public.profiles(id) on delete restrict;

-- 允许把 user_id 改写成匿名哈希（需要临时放开外键指向）
create table if not exists public.retained_identities (
  anon_id    uuid primary key,
  created_at timestamptz not null default now()
);

-- 匿名化后的账本影子表。
-- ⚠ 必须在迁移里显式建并给出主键：原先在函数体里用
--   `create table ... (like ledger including defaults)` 建，既不复制主键
--   （导致 on conflict (id) 报"没有匹配的唯一约束"），又把 DDL 放进易失函数，
--   事务一回滚表就没了。
create table if not exists public.ledger_anonymized (
  id          bigint primary key,
  user_id     uuid not null,
  type        public.ledger_type not null,
  amount      numeric(12,4) not null,
  request_id  uuid,
  ref_kind    text,
  ref_id      text,
  reason      text,
  model_usage jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists idx_ledger_anon_user on public.ledger_anonymized(user_id);
revoke all on public.ledger_anonymized from public, anon, authenticated;

create or replace function public.anonymize_ledger(p_user uuid)
returns int language plpgsql volatile security definer set search_path = pg_catalog, public as $fn$
declare v_anon uuid; v_n int;
begin
  v_anon := public.hash_for_retention(p_user);
  insert into public.retained_identities (anon_id) values (v_anon)
    on conflict (anon_id) do nothing;

  -- 账本不可 UPDATE，所以先落到影子表再删原行（删需逃生门）
  insert into public.ledger_anonymized (id, user_id, type, amount, request_id,
                                        ref_kind, ref_id, reason, model_usage, created_at)
  select id, v_anon, type, amount, request_id, ref_kind, ref_id,
         case when reason is null then 'anonymized' else reason end,
         -- 正文类字段一并清掉，只留数值
         null, created_at
    from public.ledger where user_id = p_user
    on conflict (id) do nothing;

  -- 逃生门：注销路径显式开启，且必须给理由
  perform set_config('app.ledger_purge', 'on', true);
  perform set_config('app.purge_reason', 'account erasure', true);
  delete from public.ledger where user_id = p_user;
  get diagnostics v_n = row_count;
  return v_n;
end;
$fn$;
revoke execute on function public.anonymize_ledger(uuid) from public, anon, authenticated;

create or replace function public.erase_account(p_confirm text)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, public as $fn$
declare
  v_uid uuid := auth.uid(); v_rows int; v_balance numeric;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'code', 'UNAUTHORIZED'); end if;
  -- 二次确认必须是显式输入的确认词，不接受空或勾选（09 号专篇 §1.3）
  if p_confirm is distinct from 'ERASE' then
    return jsonb_build_object('ok', false, 'code', 'CONFIRM_REQUIRED');
  end if;

  select usable into v_balance from public.balances where user_id = v_uid;
  if coalesce(v_balance, 0) > 0 then
    -- 还有钱就先删：注销路径上退款走 18 号专篇的自助申请，
    -- 但绝不因为"有余额"就不让人注销
    raise notice 'user % still has % credit', v_uid, v_balance;
  end if;

  v_rows := public.anonymize_ledger(v_uid);

  -- 级联删：messages / memories / sessions / characters / byok / push / 社区内容
  delete from public.messages      where user_id = v_uid;
  delete from public.memories      where user_id = v_uid;
  delete from public.sessions      where user_id = v_uid;
  delete from public.characters    where owner_id = v_uid;
  delete from public.stickers      where user_id = v_uid;
  delete from public.sticker_packs where user_id = v_uid;
  delete from public.byok_secrets  where user_id = v_uid;
  delete from public.byok_profiles where user_id = v_uid;
  delete from public.push_devices  where user_id = v_uid;
  delete from public.notify_prefs  where user_id = v_uid;
  delete from public.proactive_jobs where user_id = v_uid;
  delete from public.extract_jobs  where user_id = v_uid;
  delete from public.posts         where author_id = v_uid;
  delete from public.post_comments where author_id = v_uid;
  delete from public.post_reactions where user_id = v_uid;
  delete from public.share_links   where user_id = v_uid;
  delete from public.card_listings where creator_id = v_uid;
  delete from public.balances      where user_id = v_uid;
  delete from public.entitlements  where user_id = v_uid;
  delete from public.profiles      where id = v_uid;
  delete from auth.users           where id = v_uid;

  return jsonb_build_object('ok', true, 'ledger_anonymized', v_rows);
end;
$fn$;
grant execute on function public.erase_account(text) to authenticated;

-- ─── 3. 全量导出 ─────────────────────────────────────────
-- 09 号专篇 §8：免费、不受档位限制、通用格式。返回可直接下载的内容。
create or replace function public.export_bundle()
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, public as $fn$
declare
  v_uid uuid := auth.uid(); out jsonb;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'code', 'UNAUTHORIZED'); end if;

  select jsonb_build_object(
    'ok', true,
    'format', 'echosoul-export/1',
    'exported_at', now(),
    'account', (select to_jsonb(p) from (
                  select id, handle, nickname, created_at, birth_declared
                    from public.profiles where id = v_uid) p),
    'entitlements', (select to_jsonb(e) from public.entitlements e where e.user_id = v_uid),
    'credit_history', (select coalesce(jsonb_agg(jsonb_build_object(
                          'at', l.created_at, 'type', l.type, 'amount', l.amount,
                          'ref', l.ref_id, 'usage', l.model_usage) order by l.created_at), '[]'::jsonb)
                        from public.ledger l where l.user_id = v_uid),
    'orders', (select coalesce(jsonb_agg(to_jsonb(o) order by o.created_at), '[]'::jsonb)
               from public.orders o where o.user_id = v_uid),
    'characters', (select coalesce(jsonb_agg(jsonb_build_object(
                          'id', c.id, 'name', c.name, 'tagline', c.tagline,
                          'persona', c.persona_text, 'greeting', c.greeting,
                          'examples', c.example_dialogs, 'tags', c.tags,
                          'created_at', c.created_at) order by c.created_at), '[]'::jsonb)
                   from public.characters c where c.owner_id = v_uid),
    'sessions', (select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at), '[]'::jsonb)
                 from public.sessions s where s.user_id = v_uid),
    'messages', (select coalesce(jsonb_agg(jsonb_build_object(
                          'id', m.id, 'session_id', m.session_id, 'role', m.role,
                          'character_id', m.character_id, 'content', m.content,
                          'created_at', m.created_at) order by m.created_at), '[]'::jsonb)
                 from public.messages m where m.user_id = v_uid),
    'memories', (select coalesce(jsonb_agg(jsonb_build_object(
                          'id', mm.id, 'character_id', mm.character_id, 'kind', mm.kind,
                          'text', mm.text, 'salience', mm.salience, 'manual', mm.manual,
                          'sources', mm.source_msg_ids) order by mm.created_at), '[]'::jsonb)
                 from public.memories mm where mm.user_id = v_uid),
    'byok_profiles', (select coalesce(jsonb_agg(jsonb_build_object(
                          'id', b.id, 'kind', b.kind, 'label', b.label,
                          'base_url', b.base_url, 'model', b.model, 'key_mask', b.key_mask
                       ) order by b.created_at), '[]'::jsonb)
                      from public.byok_profiles b where b.user_id = v_uid)
    -- 注意：绝不包含 byok_secrets 的任何字段，也不包含 API Key 明文
  ) into out;

  return out;
end;
$fn$;
grant execute on function public.export_bundle() to authenticated;

-- 导出内容的字节数，用于前端显示"这次导出多大"
create or replace function public.export_size()
returns bigint language sql stable security definer set search_path = pg_catalog, public as $fn$
  select length(coalesce(public.export_bundle()::text, ''))::bigint;
$fn$;
grant execute on function public.export_size() to authenticated;

-- ─── 4. 审核队列（后台用）────────────────────────────────
create or replace function public.admin_queue(p_limit int default 50)
returns table (kind text, id text, title text, author text, submitted_at timestamptz, reason text)
language sql stable security definer set search_path = pg_catalog, public as $fn$
  -- UNION 的输出列名取自**第一个分支的表达式**，不是这里写的别名，
  -- 因此不能直接 order by submitted_at（实测报列不存在）。先包一层显式命名。
  select u.kind, u.id, u.title, u.author, u.submitted_at, u.reason
    from (
      select 'character'::text as kind, c.id::text as id, c.name as title,
             coalesce(p.handle, 'anon') as author,
             c.created_at as submitted_at, ''::text as reason
        from public.card_reviews r
        join public.characters c on c.id = r.character_id
        left join public.profiles p on p.id = c.owner_id
       where r.status = 'pending'
      union all
      select 'post', po.id::text, left(po.title, 60),
             coalesce(p.handle, 'anon'), po.created_at, ''
        from public.posts po left join public.profiles p on p.id = po.author_id
       where po.review_status = 'pending'
      union all
      select 'report', rt.id::text, rt.target_kind || ':' || rt.target_id,
             coalesce(p.handle, 'anon'), rt.created_at, rt.category
        from public.reports rt left join public.profiles p on p.id = rt.reporter_id
       where rt.status = 'open'
    ) u
   order by u.submitted_at
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$fn$;
revoke execute on function public.admin_queue(int) from public, anon, authenticated;

-- ─── 5. 余额与消耗自查（前端额度页用）────────────────────
create or replace function public.my_usage_days(p_days int default 30)
returns table (day date, rounds bigint, credit numeric, cached_ratio numeric)
language sql stable security definer set search_path = pg_catalog, public as $fn$
  select date_trunc('day', l.created_at)::date as day,
         count(*) filter (where l.type = 'settle') as rounds,
         coalesce(sum(l.amount) filter (where l.type = 'settle'), 0) as credit,
         coalesce(
           sum((l.model_usage->>'cached')::numeric)
             / nullif(sum((l.model_usage->>'prompt')::numeric), 0),
           0) as cached_ratio
    from public.ledger l
   where l.user_id = auth.uid()
     and l.created_at > now() - make_interval(days => least(greatest(p_days,1), 365))
   group by 1
   order by 1 desc;
$fn$;
grant execute on function public.my_usage_days(int) to authenticated;

-- ─── 自检 ───────────────────────────────────────────────
select
  (select confdeltype from pg_constraint
     where conname='characters_owner_id_fkey') = 'c'                       as fk_cascade_ok,
  (select count(*) from public.characters
     where owner_id is null and review_status <> 'approved') = 0           as no_orphan_official,
  (select count(*) from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in
     ('hash_for_retention','anonymize_ledger','erase_account','export_bundle',
      'export_size','admin_queue','my_usage_days')) = 7                    as functions_ok,
  (select has_function_privilege('authenticated','public.erase_account(text)','execute')) = true
                                                                           as erase_available,
  (select has_function_privilege('authenticated','public.anonymize_ledger(uuid)','execute')) = false
                                                                           as anonymize_internal_only,
  (select has_function_privilege('authenticated','public.admin_queue(int)','execute')) = false
                                                                           as admin_queue_locked,
  (select count(*) from pg_catalog.pg_constraint
     where conname='ck_official_approved') = 1                             as official_guard_ok;
