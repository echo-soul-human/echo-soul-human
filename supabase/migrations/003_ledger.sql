-- 003_ledger.sql
-- 不可变账本 + 余额派生 + 预冻结/结算/退回
-- 见 docs/分册-后端与数据库.md §4、docs/分册-模型与计费.md §3、§7
--
-- 记账模型（关键，别改）：
--   granted = grant + purchase + adjust            （入账方向）
--   spent   = settle                               （实际消耗）
--   frozen  = freeze - settle - refund(ref=freeze) （占用中，未结算部分）
--   usable  = granted - spent - frozen
--
-- 不变式（对账任务每日校验）：
--   I1  任一 freeze 的 settle + refund 之和不得超过其 amount（超发）
--       ⚠ 在途未结算属正常状态，不要求相等
--   I1b 同一笔 freeze 至多被 settle 一次
--   I2  同一 request_id 最多一条 freeze、最多一条 settle
--   I3  模型失败 ⇒ 该 request 的净消耗为 0
--   I4  balances 表与 ledger 重算值一致（漂移 0）

-- ─── 枚举 ────────────────────────────────────────────────
do $do$
begin
  if not exists (select 1 from pg_type where typname = 'ledger_type') then
    create type public.ledger_type as enum (
      'freeze','settle','refund','grant','purchase','byok_usage','adjust',
      'tts_grant','tts_consume','tts_refund'
    );
  end if;
end
$do$;

-- ─── 账本表 ──────────────────────────────────────────────
create table if not exists public.ledger (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete restrict,
  type        public.ledger_type not null,
  amount      numeric(12,4) not null,
  request_id  uuid,                       -- 幂等键（对话轮次）
  ref_kind    text,                       -- 'freeze' | 'order' | 'request'
  ref_id      text,                       -- 被引用流水的 id 或订单号
  reason      text,
  model_usage jsonb,                      -- {prompt,completion,cached,cost_actual}
  created_at  timestamptz not null default now()
);

create index if not exists idx_ledger_user_time on public.ledger(user_id, created_at desc);
create index if not exists idx_ledger_request   on public.ledger(request_id) where request_id is not null;
create index if not exists idx_ledger_ref       on public.ledger(ref_kind, ref_id) where ref_id is not null;

-- 幂等：同一 request_id 同一 type 只能有一条（重试不重复扣费）
create unique index if not exists uq_ledger_idem
  on public.ledger(request_id, type) where request_id is not null;

-- 金额非负（显式命名，便于自检与后续调整）
alter table public.ledger drop constraint if exists ck_ledger_amount;
alter table public.ledger add constraint ck_ledger_amount check (amount >= 0);

-- 结算/退回必须回填引用，否则冻结会永久占用余额（架构 §2.1 明确要求）
alter table public.ledger drop constraint if exists ck_ledger_ref_required;
alter table public.ledger add constraint ck_ledger_ref_required
  check (
    case
      when type in ('settle','refund') then ref_kind = 'freeze' and ref_id is not null
      else true
    end
  );

-- ─── 不可变（触发器 + 权限双锁）──────────────────────────
-- ★ 逃生门：默认一律拦截；仅当会话显式 set_config('app.ledger_purge','on') 才放行 DELETE。
--   为什么必须有：profiles 上的外键是 on delete restrict，若 ledger 完全不可删，
--   则任何产生过账本记录的用户都永远无法清除（含开发/测试数据），
--   连 postgres 也会被自己的触发器锁死。
--   放行时必须同时给出 app.purge_reason，便于事后审计；生产环境不应使用。
create or replace function public.guard_ledger_immutable()
returns trigger language plpgsql set search_path = pg_catalog, public as $fn$
begin
  if TG_OP = 'DELETE'
     and coalesce(current_setting('app.ledger_purge', true), '') = 'on' then
    -- 有意的清除操作，要求留下理由
    if coalesce(current_setting('app.purge_reason', true), '') = '' then
      raise exception 'ledger purge requires app.purge_reason to be set';
    end if;
    return old;
  end if;

  raise exception 'ledger is append-only';
end;
$fn$;

drop trigger if exists trg_ledger_no_update on public.ledger;
create trigger trg_ledger_no_update
  before update on public.ledger
  for each row execute function public.guard_ledger_immutable();

drop trigger if exists trg_ledger_no_delete on public.ledger;
create trigger trg_ledger_no_delete
  before delete on public.ledger
  for each row execute function public.guard_ledger_immutable();

revoke update, delete, truncate on public.ledger from authenticated, anon;

-- ─── 余额派生 ────────────────────────────────────────────
create or replace function public.credit_of(p_user uuid)
returns table (
  granted numeric, spent numeric, frozen numeric,
  usable numeric, tts_granted numeric, tts_spent numeric
) language sql stable set search_path = pg_catalog, public as $fn$
  select
    coalesce(sum(case when type in ('grant','purchase','adjust') then amount end), 0)
      - coalesce(sum(case when type = 'refund' and coalesce(ref_kind,'') <> 'freeze' then amount end), 0)
      as granted,
    coalesce(sum(case when type = 'settle' then amount end), 0)                        as spent,
    coalesce(sum(case when type = 'freeze' then amount end), 0)
      - coalesce(sum(case when type in ('settle','refund') and ref_kind = 'freeze' then amount end), 0)
      as frozen,
    coalesce(sum(case when type in ('grant','purchase','adjust') then amount end), 0)
      - coalesce(sum(case when type = 'refund' and coalesce(ref_kind,'') <> 'freeze' then amount end), 0)
      - coalesce(sum(case when type = 'settle' then amount end), 0)
      - (coalesce(sum(case when type = 'freeze' then amount end), 0)
         - coalesce(sum(case when type in ('settle','refund') and ref_kind = 'freeze' then amount end), 0))
      as usable,
    coalesce(sum(case when type = 'tts_grant' then amount end), 0)                     as tts_granted,
    coalesce(sum(case when type = 'tts_consume' then amount end), 0)
      - coalesce(sum(case when type = 'tts_refund' then amount end), 0)                as tts_spent
  from public.ledger
  where user_id = p_user;
$fn$;

-- 高频查询走物化视图；Edge Function 在结算后单行刷新 + 每日全量对账
create table if not exists public.balances (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  granted     numeric(12,4) not null default 0,
  spent       numeric(12,4) not null default 0,
  frozen      numeric(12,4) not null default 0,
  usable      numeric(12,4) not null default 0,
  tts_granted numeric(12,4) not null default 0,
  tts_spent   numeric(12,4) not null default 0,
  refreshed_at timestamptz not null default now()
);

create or replace function public.refresh_balance(p_user uuid)
returns void language sql volatile set search_path = pg_catalog, public as $fn$
  insert into public.balances as b
        (user_id,  granted, spent, frozen, usable, tts_granted, tts_spent, refreshed_at)
  select p_user,   c.granted, c.spent, c.frozen, c.usable, c.tts_granted, c.tts_spent, now()
    from public.credit_of(p_user) c
  on conflict (user_id) do update
    set granted = excluded.granted, spent = excluded.spent, frozen = excluded.frozen,
        usable = excluded.usable, tts_granted = excluded.tts_granted,
        tts_spent = excluded.tts_spent, refreshed_at = now();
$fn$;

-- balances 行的初始创建在 002 的 on_user_created 触发器内完成。
-- 此处刻意不再建第二个 auth.users 触发器：Postgres 对同时机触发器按名字字母序
-- 执行，两个触发器会让 balances 早于 profiles 插入而违反外键。
drop trigger if exists trg_user_balance on auth.users;
drop function if exists public.on_user_created_v2();

-- ─── 预冻结 ──────────────────────────────────────────────
create or replace function public.freeze_credit(
  p_user uuid, p_amount numeric, p_request uuid
) returns jsonb language plpgsql volatile set search_path = pg_catalog, public as $fn$
declare
  v_row public.ledger%rowtype;
  v_usable numeric;
begin
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'code', 'BAD_AMOUNT');
  end if;

  -- 幂等重放：同 request 已冻结则直接返回既有结果
  select * into v_row from public.ledger
   where request_id = p_request and type = 'freeze' limit 1;
  if found then
    return jsonb_build_object('ok', true, 'replay', true, 'ledger_id', v_row.id,
                              'amount', v_row.amount);
  end if;

  -- 用户级行锁：串行化同一用户的并发扣费
  perform 1 from public.profiles where id = p_user for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NO_SUCH_USER');
  end if;

  select usable into v_usable from public.balances where user_id = p_user;
  if v_usable is null then
    perform public.refresh_balance(p_user);
    select usable into v_usable from public.balances where user_id = p_user;
  end if;

  if coalesce(v_usable, 0) < p_amount then
    return jsonb_build_object('ok', false, 'code', 'INSUFFICIENT_BALANCE',
                              'usable', coalesce(v_usable, 0), 'need', p_amount);
  end if;

  insert into public.ledger (user_id, type, amount, request_id)
       values (p_user, 'freeze', p_amount, p_request)
    returning * into v_row;

  perform public.refresh_balance(p_user);
  return jsonb_build_object('ok', true, 'replay', false,
                            'ledger_id', v_row.id, 'amount', v_row.amount);
end;
$fn$;

-- ─── 结算 ────────────────────────────────────────────────
create or replace function public.settle_credit(
  p_freeze_id bigint, p_actual numeric, p_usage jsonb default null
) returns jsonb language plpgsql volatile set search_path = pg_catalog, public as $fn$
declare
  v_fz public.ledger%rowtype;
  v_existing bigint;
  v_diff numeric;
begin
  -- 锁住冻结行：防止并发重复结算
  select * into v_fz from public.ledger where id = p_freeze_id and type = 'freeze' for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'FREEZE_NOT_FOUND');
  end if;

  select id into v_existing from public.ledger
   where ref_kind = 'freeze' and ref_id = p_freeze_id::text and type = 'settle' limit 1;
  if v_existing is not null then
    return jsonb_build_object('ok', true, 'replay', true, 'settle_id', v_existing);
  end if;

  if p_actual is null or p_actual < 0 then
    return jsonb_build_object('ok', false, 'code', 'BAD_AMOUNT');
  end if;
  if p_actual > v_fz.amount then
    p_actual := v_fz.amount;   -- 绝不允许结算超过冻结额（超付防线）
  end if;

  insert into public.ledger (user_id, type, amount, request_id, ref_kind, ref_id, model_usage)
       values (v_fz.user_id, 'settle', p_actual, v_fz.request_id, 'freeze', p_freeze_id::text, p_usage);

  v_diff := v_fz.amount - p_actual;
  if v_diff > 0 then
    insert into public.ledger (user_id, type, amount, ref_kind, ref_id, reason)
         values (v_fz.user_id, 'refund', v_diff, 'freeze', p_freeze_id::text, 'freeze_remainder');
  end if;

  perform public.refresh_balance(v_fz.user_id);
  return jsonb_build_object('ok', true, 'settled', p_actual, 'refunded', v_diff);
end;
$fn$;

-- ─── 全额退回（模型失败必调）─────────────────────────────
create or replace function public.refund_credit(
  p_freeze_id bigint, p_reason text default 'model_error'
) returns jsonb language plpgsql volatile set search_path = pg_catalog, public as $fn$
declare
  v_fz public.ledger%rowtype;
  v_existing bigint;
  v_settled numeric;
begin
  select * into v_fz from public.ledger where id = p_freeze_id and type = 'freeze' for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'FREEZE_NOT_FOUND');
  end if;

  select id into v_existing from public.ledger
   where ref_kind = 'freeze' and ref_id = p_freeze_id::text and type = 'refund'
     and reason = p_reason limit 1;
  if v_existing is not null then
    return jsonb_build_object('ok', true, 'replay', true, 'refund_id', v_existing);
  end if;

  -- 若已有 settle（流中断但已产出），只退剩余部分
  select coalesce(sum(amount),0) into v_settled from public.ledger
   where ref_kind = 'freeze' and ref_id = p_freeze_id::text and type = 'settle';

  if v_fz.amount - v_settled > 0 then
    insert into public.ledger (user_id, type, amount, request_id, ref_kind, ref_id, reason)
         values (v_fz.user_id, 'refund', v_fz.amount - v_settled, v_fz.request_id,
                 'freeze', p_freeze_id::text, p_reason);
    perform public.refresh_balance(v_fz.user_id);
  end if;

  return jsonb_build_object('ok', true, 'refunded', v_fz.amount - v_settled);
end;
$fn$;

-- ─── 发放（爱发电到账 / 体验额度 / 加量包）────────────────
create or replace function public.grant_credit(
  p_user uuid, p_amount numeric, p_type public.ledger_type,
  p_order text, p_reason text default null
) returns jsonb language plpgsql volatile set search_path = pg_catalog, public as $fn$
declare
  v_existing bigint;
begin
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'code', 'BAD_AMOUNT');
  end if;

  -- 幂等：同一订单同一类型只发一次（17 号专篇 §7、重复回调防线）
  if p_order is not null then
    select id into v_existing from public.ledger
     where user_id = p_user and type = p_type and ref_kind = 'order' and ref_id = p_order limit 1;
    if v_existing is not null then
      return jsonb_build_object('ok', true, 'replay', true, 'ledger_id', v_existing);
    end if;
  end if;

  perform 1 from public.profiles where id = p_user for update;

  insert into public.ledger (user_id, type, amount, ref_kind, ref_id, reason)
       values (p_user, p_type, p_amount, case when p_order is not null then 'order' end, p_order, p_reason);

  perform public.refresh_balance(p_user);
  return jsonb_build_object('ok', true, 'replay', false);
end;
$fn$;

-- ─── BYOK 用量记录（amount=0，不扣费但可统计与反滥用）─────
create or replace function public.log_byok_usage(
  p_user uuid, p_request uuid, p_usage jsonb
) returns void language sql volatile set search_path = pg_catalog, public as $fn$
  insert into public.ledger (user_id, type, amount, request_id, model_usage)
  values (p_user, 'byok_usage', 0, p_request, p_usage)
  on conflict (request_id, type) where request_id is not null do nothing;
$fn$;

-- ─── 不变式校验（每日对账任务调用，19 号专篇 §7.3）────────
create or replace function public.audit_ledger_invariants(p_user uuid default null)
returns jsonb language sql stable set search_path = pg_catalog, public as $fn$
  with fz as (
    select id, amount, user_id from public.ledger
     where type = 'freeze' and (p_user is null or user_id = p_user)
  ),
  paired as (
    select f.id, f.amount,
           coalesce(sum(case when l.type = 'settle' then l.amount end), 0) as settled,
           coalesce(sum(case when l.type = 'refund' then l.amount end), 0) as refunded
      from fz f
      left join public.ledger l
        on l.ref_kind = 'freeze' and l.ref_id = f.id::text
     group by f.id, f.amount
  ),
  i1 as (
    -- 违规 = 释放额超过冻结额（超发），或结算额本身超过冻结额。
    -- ⚠ 刻意**不**用 `settled + refunded <> amount`：
    --   在途未结算的冻结本来就不相等，那样会把正常的并发压测判成故障。
    select count(*) as bad from paired
      where settled + refunded > amount or settled > amount
  ),
  i1b as (
    -- 同一笔冻结被结算多次
    select count(*) as bad from (
      select ref_id from public.ledger
       where ref_kind = 'freeze' and type = 'settle'
         and (p_user is null or user_id = p_user)
       group by ref_id having count(*) > 1
    ) d
  ),
  i2 as (
    select count(*) as bad from (
      select request_id, type, count(*) as c from public.ledger
       where request_id is not null and type in ('freeze','settle')
         and (p_user is null or user_id = p_user)
       group by request_id, type having count(*) > 1
    ) d
  ),
  drift as (
    select count(*) as bad
      from public.balances b
      join lateral (select * from public.credit_of(b.user_id)) c on true
     where (p_user is null or b.user_id = p_user)
       and (b.usable, b.granted, b.spent, b.frozen)
        is distinct from (c.usable, c.granted, c.spent, c.frozen)
  )
  select jsonb_build_object(
    'i1_over_released',   (select bad from i1),
    'i1b_double_settled', (select bad from i1b),
    'i2_duplicate_request', (select bad from i2),
    'i3_balance_drift',     (select bad from drift),
    'healthy',              (select bad from i1) = 0
                              and (select bad from i1b) = 0
                              and (select bad from i2) = 0
                              and (select bad from drift) = 0
  );
$fn$;

-- ─── 自检 ───────────────────────────────────────────────
select
  (select count(*) from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in
     ('credit_of','refresh_balance','freeze_credit','settle_credit',
      'refund_credit','grant_credit','log_byok_usage','audit_ledger_invariants',
      'guard_ledger_immutable')) = 9                                   as functions_ok,
  (select count(*) from pg_catalog.pg_trigger t
     join pg_catalog.pg_class c on c.oid = t.tgrelid
    where c.relname = 'ledger' and not t.tgisinternal) = 2        as ledger_triggers_ok,
  (select count(*) from pg_catalog.pg_constraint
    where conrelid = 'public.ledger'::regclass and contype = 'c'
      and conname in ('ck_ledger_ref_required','ck_ledger_amount')) = 2         as ledger_constraints_ok,
  (select count(*) from pg_catalog.pg_indexes
    where tablename = 'ledger' and indexname = 'uq_ledger_idem') = 1 as idem_index_ok,
  (select (usable is not null) from public.credit_of(
     (select id from public.profiles limit 1)) )                  as credit_of_runs_ok;
