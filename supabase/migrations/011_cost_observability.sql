-- 011_cost_observability.sql
-- 成本可观测：缓存命中率、单轮成本、按档位毛利反推
--
-- 为什么必须有：静态前缀一旦被无意破坏，提示词缓存击穿，
-- 单轮成本涨约 3.2 倍 —— 而且**不会报错，只会悄悄亏钱**。
-- docs/分册-模型与计费.md §2.4 把命中率 ≥90% 定为出口判据，
-- 但没有聚合与告警就等于没有观测。
-- 幂等：可重复执行。

-- ─── 1. 逐轮成本事实表 ───────────────────────────────────
-- 不直接查 messages：那里没有缓存命中数，而命中率正是要观测的东西。
-- chat 每次结算时写一行，字段与 provider 回传的 usage 对齐。
create table if not exists public.chat_turns (
  id            bigint generated always as identity primary key,
  user_id       uuid not null,
  character_id  uuid,
  session_id    uuid,
  provider      text not null default 'deepseek',
  model         text not null default '',
  request_id    uuid,
  prompt_tokens int not null default 0,
  cached_tokens int not null default 0,
  completion_tokens int not null default 0,
  cost_cny      numeric(12,6) not null default 0,
  credit_charged numeric(12,6) not null default 0,
  carried_tokens int not null default 0,
  recall_used   int not null default 0,
  latency_ms    int,
  ok            boolean not null default true,
  error_code    text,
  created_at    timestamptz not null default now()
);

create index if not exists idx_turns_time on public.chat_turns(created_at desc);
create index if not exists idx_turns_char on public.chat_turns(character_id, created_at desc);
create index if not exists idx_turns_user on public.chat_turns(user_id, created_at desc);

alter table public.chat_turns enable row level security;
drop policy if exists p_turns_own on public.chat_turns;
create policy p_turns_own on public.chat_turns
  for select to authenticated using (user_id = auth.uid());
-- 写入只能经 Edge Function（service_role）

-- ─── 2. 命中率：核心指标 ─────────────────────────────────
-- 命中率的分母是**可命中的部分**，即静态前缀（A+B+C 段）。
-- 用 prompt_tokens 做分母会把 RAG 与历史算进去，命中率被系统性低估，
-- 看上去像"前缀被破坏了"而其实是分母错了 —— 这个细节必须写死在这里，
-- 不能让每个看板各算一遍。
create or replace function public.cache_hit_rate(
  p_since timestamptz default now() - interval '24 hours',
  p_character uuid default null
) returns table (
  bucket timestamptz,
  turns bigint,
  prompt_tokens bigint,
  cached_tokens bigint,
  hit_rate numeric,
  avg_cost numeric,
  p95_cost numeric
) language sql stable security definer set search_path = pg_catalog, public as $fn$
  -- ⚠ 必须 coalesce：显式传 NULL 时函数的默认值**不生效**
  --   （默认值只在省略参数时套用），于是 created_at >= NULL 恒为 NULL、
  --   整个查询静默返回空。调用方传 null 表示"用默认窗口"是自然写法。
  with scoped as (
    select date_trunc('hour', t.created_at) as b, t.*
      from public.chat_turns t
     where t.created_at >= coalesce(p_since, now() - interval '24 hours')
       and t.ok
       and (p_character is null or t.character_id = p_character)
  )
  select b as bucket,
         count(*) as turns,
         sum(prompt_tokens)::bigint as prompt_tokens,
         sum(cached_tokens)::bigint as cached_tokens,
         case when sum(prompt_tokens) > 0
              then round(sum(cached_tokens)::numeric / sum(prompt_tokens), 4)
              else 0 end as hit_rate,
         round(avg(cost_cny), 6) as avg_cost,
         round((percentile_cont(0.95) within group (order by cost_cny))::numeric, 6) as p95_cost
    from scoped
   group by b
   order by b desc;
$fn$;
revoke execute on function public.cache_hit_rate(timestamptz, uuid) from public, anon, authenticated;

/** 看板用：按角色汇总，用来定位"哪个角色的前缀被写坏了" */
create or replace function public.cache_hit_by_character(
  p_since timestamptz default now() - interval '24 hours'
) returns table (
  character_id uuid, character_name text, turns bigint,
  hit_rate numeric, avg_cost numeric, total_cost numeric
) language sql stable security definer set search_path = pg_catalog, public as $fn$
  select t.character_id,
         coalesce(c.name, '(已删除)'),
         count(*),
         case when sum(t.prompt_tokens) > 0
              then round(sum(t.cached_tokens)::numeric / sum(t.prompt_tokens), 4)
              else 0 end,
         round(avg(t.cost_cny), 6),
         round(sum(t.cost_cny), 4)
    from public.chat_turns t
    left join public.characters c on c.id = t.character_id
   where t.created_at >= coalesce(p_since, now() - interval '24 hours') and t.ok
   group by t.character_id, c.name
   order by sum(t.cost_cny) desc;
$fn$;
revoke execute on function public.cache_hit_by_character(timestamptz) from public, anon, authenticated;

-- ─── 3. 毛利反推：哪一档在亏钱 ───────────────────────────
-- docs/分册-模型与计费.md §3.3：定价假设的零售倍率是 6×，
-- 低于 4.5× 告警，低于 3.5× 需在后台置顶。
-- 用 chat_turns 而不是 ledger：ledger 的 cost_actual 是估算值，
-- 这里要的是"实际扣了多少钱 / 实际花了多少钱"。
create or replace function public.tier_margin(
  p_days int default 30
) returns table (
  tier text, users bigint, turns bigint,
  credit_charged numeric, real_cost numeric,
  retail_multiple numeric, alert text
) language sql stable security definer set search_path = pg_catalog, public as $fn$
  with scoped as (
    select e.tier::text as tier, t.user_id, t.credit_charged, t.cost_cny
      from public.chat_turns t
      join public.entitlements e on e.user_id = t.user_id
     where t.created_at > now() - make_interval(days => least(greatest(p_days, 1), 365))
       and t.ok and t.credit_charged > 0
  )
  select tier,
         count(distinct user_id),
         count(*),
         round(sum(credit_charged), 4),
         round(sum(cost_cny), 4),
         case when sum(cost_cny) > 0
              then round(sum(credit_charged) / sum(cost_cny), 2)
              else null end,
         case
           when sum(cost_cny) <= 0 then null
           when sum(credit_charged) / sum(cost_cny) < 3.5 then 'critical'
           when sum(credit_charged) / sum(cost_cny) < 4.5 then 'warn'
           else null
         end
    from scoped
   group by tier
   order by 6 nulls last;
$fn$;
revoke execute on function public.tier_margin(int) from public, anon, authenticated;

-- ─── 4. 命中率告警：写进审计表，后台可见 ─────────────────
create or replace function public.check_prefix_health(
  p_window_minutes int default 60, p_min_rate numeric default 0.90
) returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, public as $fn$
declare
  v_turns bigint; v_rate numeric; v_avg numeric; v_bad text[] := '{}';
begin
  select count(*), 
         case when sum(prompt_tokens) > 0 then sum(cached_tokens)::numeric / sum(prompt_tokens) else 1 end,
         coalesce(avg(cost_cny), 0)
    into v_turns, v_rate, v_avg
    from public.chat_turns
   where created_at > now() - make_interval(mins => least(greatest(p_window_minutes, 5), 1440))
     and ok;

  -- 样本太少时不判定，避免凌晨低流量误报
  if coalesce(v_turns, 0) < 20 then
    return jsonb_build_object('ok', true, 'skipped', true, 'turns', coalesce(v_turns, 0),
                              'reason', 'LOW_SAMPLE');
  end if;

  -- 定位到具体角色：整体命中率低通常只有少数角色的前缀被改坏
  select coalesce(array_agg(x.nm), '{}') into v_bad
    from (
      select c.name as nm
        from public.chat_turns t
        join public.characters c on c.id = t.character_id
       where t.created_at > now() - make_interval(mins => least(greatest(p_window_minutes, 5), 1440))
         and t.ok
       group by c.name
      having count(*) >= 5
         and sum(t.cached_tokens)::numeric / nullif(sum(t.prompt_tokens), 0) < p_min_rate
    ) x;

  if v_rate < p_min_rate then
    insert into public.admin_audit (actor, action, target, detail)
    values ('system', 'prefix_health_alarm', 'cache_hit_rate',
            'rate=' || round(v_rate, 4) || ' turns=' || v_turns
            || ' avg_cost=' || round(v_avg, 6)
            || ' bad_characters=' || array_to_string(v_bad, ','));
  end if;

  return jsonb_build_object(
    'ok', v_rate >= p_min_rate,
    'hit_rate', round(v_rate, 4),
    'turns', v_turns,
    'avg_cost', round(v_avg, 6),
    'suspect_characters', to_jsonb(v_bad),
    'threshold', p_min_rate
  );
end;
$fn$;
revoke execute on function public.check_prefix_health(int, numeric) from public, anon, authenticated;

-- ─── 5. 用户侧：我这一轮花了多少 ─────────────────────────
-- 前端"消耗可视化"读这个。刻意只回自己那几行，且不暴露成本价。
create or replace function public.my_turns(p_limit int default 50)
returns table (
  at timestamptz, character_name text, prompt_tokens int, cached_tokens int,
  completion_tokens int, credit numeric, cache_hit boolean
) language sql stable security definer set search_path = pg_catalog, public as $fn$
  select t.created_at, coalesce(c.name, ''),
         t.prompt_tokens, t.cached_tokens, t.completion_tokens,
         round(t.credit_charged, 4),
         t.cached_tokens > 0
    from public.chat_turns t
    left join public.characters c on c.id = t.character_id
   where t.user_id = auth.uid()
   order by t.created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$fn$;
grant execute on function public.my_turns(int) to authenticated;

-- ─── 6. 后台：每日成本与毛利总览 ─────────────────────────
create or replace view public.admin_cost_daily as
  select date_trunc('day', t.created_at) as day,
         count(*) as turns,
         count(distinct t.user_id) as users,
         round(sum(t.credit_charged), 4) as credit_charged,
         round(sum(t.cost_cny), 6) as real_cost,
         case when sum(t.cost_cny) > 0
              then round(sum(t.credit_charged) / sum(t.cost_cny), 2)
              else null end as retail_multiple,
         case when sum(t.prompt_tokens) > 0
              then round(sum(t.cached_tokens)::numeric / sum(t.prompt_tokens), 4)
              else 0 end as hit_rate,
         round(avg(t.cost_cny), 6) as avg_cost_per_turn
    from public.chat_turns t
   where t.ok
   group by 1
   order by 1 desc;

revoke all on public.admin_cost_daily from anon, authenticated;

-- ─── 自检 ───────────────────────────────────────────────
select
  (select count(*) from pg_catalog.pg_tables where schemaname='public'
     and tablename='chat_turns') = 1                                        as turns_table_ok,
  (select count(*) from pg_catalog.pg_indexes where tablename='chat_turns') >= 4
                                                                             as turns_indexes_ok,
  (select count(*) from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname in
     ('cache_hit_rate','cache_hit_by_character','tier_margin',
      'check_prefix_health','my_turns')) = 5                                 as functions_ok,
  (select has_function_privilege('authenticated','public.cache_hit_rate(timestamptz,uuid)','execute')) = false
                                                                             as hitrate_internal_only,
  (select has_function_privilege('authenticated','public.check_prefix_health(int,numeric)','execute')) = false
                                                                             as health_internal_only,
  (select has_function_privilege('authenticated','public.my_turns(int)','execute')) = true
                                                                             as my_turns_available,
  (select count(*) from pg_catalog.pg_views where schemaname='public'
     and viewname='admin_cost_daily') = 1                                    as cost_view_ok,
  (select relrowsecurity from pg_class where oid='public.chat_turns'::regclass) = true
                                                                             as turns_rls_on;
