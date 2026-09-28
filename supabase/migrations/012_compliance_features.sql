-- 012_compliance_features.sql
-- 补齐协议已承诺、但产品尚未实现的 5 项能力
--
-- 背景：docs/legal/README.md 第五节列了这些缺口。协议里写了"每超 2 小时提醒"
-- "未成年人 40 分钟提醒与宵禁提示""监护人可提出请求""官方渠道页"
-- "AI 生成内容标识"——产品没有实现就等于协议在说谎。
-- 幂等：可重复执行。

-- ─── 1. 使用时长统计 ─────────────────────────────────────
-- 客户端心跳驱动。为什么不放服务端按登录时长算：
-- 用户挂着页面去吃饭不是"使用"，只有仍在交互才算，否则提醒会失真。
create table if not exists public.usage_daily (
  user_id       uuid not null references public.profiles(id) on delete cascade,
  day           date not null,
  active_seconds int not null default 0,
  messages_sent int not null default 0,
  last_beat_at  timestamptz,
  -- 已触发过的提醒，避免同一天反复弹
  notified      jsonb not null default '{}'::jsonb,
  primary key (user_id, day)
);
alter table public.usage_daily enable row level security;
drop policy if exists p_usage_own on public.usage_daily;
create policy p_usage_own on public.usage_daily
  for select to authenticated using (user_id = auth.uid());

/**
 * 心跳：客户端每 30~60 秒调一次。
 * 只把"距上次心跳 ≤90 秒"的间隔计入活跃时长 —— 否则挂机整夜会被算成使用，
 * 然后弹出毫无意义的"你已使用 8 小时"。
 */
create or replace function public.usage_heartbeat(p_session uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, public as $fn$
declare
  v_uid uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Shanghai')::date;
  v_last timestamptz;
  v_delta int := 0;
  v_total int;
  v_is_minor boolean;
  v_notices jsonb;
  v_fire text[] := '{}';
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'code', 'UNAUTHORIZED'); end if;

  select last_beat_at, notified into v_last, v_notices
    from public.usage_daily where user_id = v_uid and day = v_today;

  if v_last is not null and now() - v_last <= interval '90 seconds' then
    v_delta := least(extract(epoch from (now() - v_last))::int, 90);
  end if;

  insert into public.usage_daily (user_id, day, active_seconds, last_beat_at)
    values (v_uid, v_today, greatest(v_delta, 0), now())
  on conflict (user_id, day) do update
    set active_seconds = public.usage_daily.active_seconds + greatest(v_delta, 0),
        last_beat_at = now();

  select active_seconds, notified, coalesce(e.is_minor, false)
    into v_total, v_notices, v_is_minor
    from public.usage_daily u
    left join public.entitlements e on e.user_id = u.user_id
   where u.user_id = v_uid and u.day = v_today;

  -- 27 号专篇 §4.1：未成年人连续 40 分钟提醒一次，成人累计 2 小时提醒一次。
  -- 刻意**不强制下线** —— 强制中断会激化对立，且对深夜情绪脆弱的用户可能反效果。
  -- ★ 去重键必须与下面 v_fire 里写入的键**完全一致**。
  --   原先检查读 'h2'/'m40'/'late' 而写入存 'adult_2h'/'minor_40min'/'minor_late_night'，
  --   于是每条提醒每次心跳都会重复触发（实测抓到）。
  --   提醒键常量：adult_2h / minor_40min / minor_late_night
  if v_is_minor then
    if v_total >= 2400 and coalesce(v_notices->>'minor_40min', '') = '' then
      v_fire := array_append(v_fire, 'minor_40min');
    end if;
  else
    if v_total >= 7200 and coalesce(v_notices->>'adult_2h', '') = '' then
      v_fire := array_append(v_fire, 'adult_2h');
    end if;
  end if;

  -- 27 号专篇 §4.2：23:00–05:00 给未成年人一次温和提示（不是强制下线）
  if v_is_minor then
    declare v_hour int := extract(hour from (now() at time zone 'Asia/Shanghai'));
    begin
      if (v_hour >= 23 or v_hour < 5)
         and coalesce(v_notices->>'minor_late_night', '') = '' then
        v_fire := array_append(v_fire, 'minor_late_night');
      end if;
    end;
  end if;

  if array_length(v_fire, 1) > 0 then
    update public.usage_daily
       set notified = notified || (
             select jsonb_object_agg(k, now()::text)
               from unnest(v_fire) as k)
     where user_id = v_uid and day = v_today;
  end if;

  return jsonb_build_object(
    'ok', true,
    'today_seconds', v_total,
    'is_minor', v_is_minor,
    'fire', to_jsonb(v_fire)
  );
end;
$fn$;
grant execute on function public.usage_heartbeat(uuid) to authenticated;

/** 用户自己看使用时长（28 号专篇 §4.1(c)：时长统计对用户可见） */
create or replace function public.my_usage(p_days int default 30)
returns table (day date, active_seconds int, messages_sent int)
language sql stable security definer set search_path = pg_catalog, public as $fn$
  select u.day, u.active_seconds, u.messages_sent
    from public.usage_daily u
   where u.user_id = auth.uid()
     and u.day > current_date - least(greatest(p_days, 1), 365)
   order by u.day desc;
$fn$;
grant execute on function public.my_usage(int) to authenticated;

/** 发消息时调一次，用于"消息数"维度（时长之外的另一条线索） */
create or replace function public.bump_message_count()
returns void language plpgsql volatile security definer set search_path = pg_catalog, public as $fn$
declare v_uid uuid := auth.uid(); v_today date := (now() at time zone 'Asia/Shanghai')::date;
begin
  if v_uid is null then return; end if;
  insert into public.usage_daily (user_id, day, messages_sent)
    values (v_uid, v_today, 1)
  on conflict (user_id, day) do update set messages_sent = public.usage_daily.messages_sent + 1;
end;
$fn$;
grant execute on function public.bump_message_count() to authenticated;

-- ─── 2. 官方渠道（21 号专篇第五章：识别真假）──────────────
create table if not exists public.official_channels (
  id          text primary key,
  kind        text not null check (kind in ('email','account','domain','download','group')),
  platform    text not null default '',
  label       text not null,
  value       text not null,
  is_primary  boolean not null default false,
  sort        int not null default 100,
  enabled     boolean not null default true,
  updated_at  timestamptz not null default now()
);
alter table public.official_channels enable row level security;
drop policy if exists p_channels_read on public.official_channels;
create policy p_channels_read on public.official_channels
  for select to authenticated, anon using (enabled);

-- 初始值。这些都是"可公开"的信息，写进迁移而不是让前端手抄 ——
-- 手抄会出现"页面说官方邮箱是 A，协议里写的是 B"这种最难查的不一致。
insert into public.official_channels (id, kind, platform, label, value, is_primary, sort) values
  ('mail_main',   'email',    '',        '官方邮箱',       'echo-soul-human@outlook.com', true,  10),
  ('site_main',   'domain',   '',        '官网与网页版',   'https://echo-soul-human.github.io/', true, 20),
  ('repo_main',   'domain',   'GitHub',  '代码仓库（问题反馈）', 'https://github.com/echo-soul-human/echo-soul-human', false, 30),
  ('dl_android',  'download', '安卓',    '安卓包唯一下载地址', '见官网下载页', true, 40)
on conflict (id) do update
  set label = excluded.label, value = excluded.value,
      is_primary = excluded.is_primary, sort = excluded.sort;

-- 反诈硬规则也落库，前端与协议引用同一份（21 号专篇第一章 N1–N11）
create table if not exists public.never_do_rules (
  id     int primary key,
  text   text not null,
  sort   int not null default 100,
  enabled boolean not null default true
);
alter table public.never_do_rules enable row level security;
drop policy if exists p_never_read on public.never_do_rules;
create policy p_never_read on public.never_do_rules
  for select to authenticated, anon using (enabled);

insert into public.never_do_rules (id, text, sort) values
  (1,  '向您索要 API Key —— 无论是完整 Key 还是"后几位用于核对"', 10),
  (2,  '向您索要邮箱验证码、登录令牌、会话标识', 20),
  (3,  '向您索要支付密码、银行卡号、CVV、身份证支付信息', 30),
  (4,  '要求您通过微信、QQ、支付宝私下转账付款', 40),
  (5,  '要求您添加某个私人账号"开通权限""解锁功能""加入白名单"', 50),
  (6,  '要求您下载任何安装包、插件、模组、"客户端补丁"', 60),
  (7,  '要求您扫描二维码以"领取额度""验证身份"', 70),
  (8,  '主动联系您推销会员、角色卡、"内部渠道"', 80),
  (9,  '声称能"解除内容限制""提供无违禁词版本"并收费', 90),
  (10, '以"账号异常需要处理"为名要求您提供信息或付款', 100),
  (11, '通过短信、邮件、站内消息附带链接要求您重新输入 Key 或密码', 110)
on conflict (id) do update set text = excluded.text, sort = excluded.sort;

-- ─── 3. AI 生成内容标识的隐式元数据（29 号专篇第三章）────
-- 显式标识在前端（角落细字 + 分享图强制保留）；隐式标识落这里，
-- 用于导出文件与追溯。
create table if not exists public.content_labels (
  asset_id     uuid primary key default gen_random_uuid(),
  owner_id     uuid references public.profiles(id) on delete set null,
  kind         text not null check (kind in ('message','image','audio','card','share')),
  ref_id       text,
  generated_by text not null default 'ai',
  provider     text not null default '',
  model        text not null default '',
  label_version text not null default 'v1',
  prompt_hash  text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_label_ref on public.content_labels(kind, ref_id);
alter table public.content_labels enable row level security;
drop policy if exists p_label_own on public.content_labels;
create policy p_label_own on public.content_labels
  for select to authenticated using (owner_id = auth.uid());

/** 生成资产标识，供导出/分享写入元数据。返回可嵌入文件的字段组 */
create or replace function public.label_asset(
  p_kind text, p_ref text default null, p_model text default '', p_prompt_hash text default null
) returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, public as $fn$
declare v_uid uuid := auth.uid(); v_id uuid;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'code', 'UNAUTHORIZED'); end if;
  if p_kind not in ('message','image','audio','card','share') then
    return jsonb_build_object('ok', false, 'code', 'BAD_KIND');
  end if;

  insert into public.content_labels (owner_id, kind, ref_id, provider, model, prompt_hash)
    values (v_uid, p_kind, p_ref, 'deepseek', p_model, p_prompt_hash)
    returning asset_id into v_id;

  return jsonb_build_object(
    'ok', true,
    'asset_id', v_id,
    -- 这三项是要写进文件元数据的字段，命名固定，导出端不要自行发挥
    'meta', jsonb_build_object(
      'ai_generated', true,
      'generator', 'echosoul',
      'asset_id', v_id,
      'label_version', 'v1'
    )
  );
end;
$fn$;
grant execute on function public.label_asset(text, text, text, text) to authenticated;

-- ─── 4. 监护人通道（27 号专篇 §5）────────────────────────
create table if not exists public.guardian_requests (
  id          bigint generated always as identity primary key,
  request_no  text not null unique,
  kind        text not null check (kind in ('erase_account','limit_features','refund','report','other')),
  target_email text not null default '',
  detail      text not null default '',
  contact     text not null default '',
  status      text not null default 'received'
                check (status in ('received','verifying','processing','done','rejected')),
  reviewer    text not null default '',
  result      text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.guardian_requests enable row level security;
-- 无 policy ⇒ 用户与监护人都不能直接读表，必须走下面这个受控函数查状态

/** 监护人提交请求。刻意不校验登录态 —— 监护人可能没有账号。 */
create or replace function public.submit_guardian_request(
  p_kind text, p_target_email text, p_detail text, p_contact text
) returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, public as $fn$
declare v_no text;
begin
  if p_kind not in ('erase_account','limit_features','refund','report','other') then
    return jsonb_build_object('ok', false, 'code', 'BAD_KIND');
  end if;
  if coalesce(trim(p_detail), '') = '' or coalesce(trim(p_contact), '') = '' then
    return jsonb_build_object('ok', false, 'code', 'DETAIL_REQUIRED');
  end if;

  -- 受理号：可读、可核对，不含时间以外的信息
  v_no := 'GR' || to_char(now() at time zone 'Asia/Shanghai', 'YYYYMMDD')
          || substr(md5(random()::text), 1, 4);

  insert into public.guardian_requests (request_no, kind, target_email, detail, contact)
    values (v_no, p_kind, left(coalesce(p_target_email, ''), 200),
            left(p_detail, 2000), left(p_contact, 200));

  -- 27 号专篇 §5.5：监护人请求响应时限 7 个工作日（快于一般请求的 15 个）
  return jsonb_build_object(
    'ok', true, 'request_no', v_no,
    'response_within_days', 7,
    'note', '我们会在这个期限内处理。请记下受理号，之后可凭它查询进度。'
  );
end;
$fn$;
grant execute on function public.submit_guardian_request(text, text, text, text) to anon, authenticated;

/** 凭受理号查进度。只回状态与结果，不回任何账号内容。 */
create or replace function public.guardian_status(p_no text)
returns jsonb language sql stable security definer set search_path = pg_catalog, public as $fn$
  select jsonb_build_object(
    'ok', true,
    'request_no', g.request_no,
    'kind', g.kind,
    'status', g.status,
    'result', g.result,
    'submitted_at', g.created_at,
    'updated_at', g.updated_at)
    from public.guardian_requests g
   where g.request_no = trim(p_no);
$fn$;
grant execute on function public.guardian_status(text) to anon, authenticated;

-- ─── 5. 登出全部会话（21 号专篇 §4.1 第 3 步）────────────
create or replace function public.my_sessions_count()
returns int language sql stable security definer set search_path = pg_catalog, public as $fn$
  select count(*)::int from auth.sessions where user_id = auth.uid();
$fn$;
grant execute on function public.my_sessions_count() to authenticated;

-- ─── 6. 反诈与健康使用提示的触发记录（避免重复弹）───────
create table if not exists public.notice_log (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  slug       text not null,
  shown_at   timestamptz not null default now(),
  dismissed  boolean not null default false,
  primary key (user_id, slug)
);
alter table public.notice_log enable row level security;
drop policy if exists p_notice_own on public.notice_log;
create policy p_notice_own on public.notice_log
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

/** 一次性或可重复提示的统一入口：已看过的不再返回 */
create or replace function public.claim_notice(p_slug text, p_repeatable boolean default false)
returns boolean language plpgsql volatile security definer set search_path = pg_catalog, public as $fn$
declare v_uid uuid := auth.uid(); v_exists boolean;
begin
  if v_uid is null then return false; end if;
  select exists(select 1 from public.notice_log where user_id = v_uid and slug = p_slug)
    into v_exists;
  if v_exists and not p_repeatable then return false; end if;

  insert into public.notice_log (user_id, slug) values (v_uid, p_slug)
    on conflict (user_id, slug) do update set shown_at = now();
  return true;
end;
$fn$;
grant execute on function public.claim_notice(text, boolean) to authenticated;

-- ─── 自检 ───────────────────────────────────────────────
select
  (select count(*) from pg_catalog.pg_tables where schemaname='public'
     and tablename in ('usage_daily','official_channels','never_do_rules',
                       'content_labels','guardian_requests','notice_log')) = 6
                                                                          as tables_ok,
  (select count(*) from public.never_do_rules) = 11                        as rules_ok,
  (select count(*) from public.official_channels where enabled) >= 4       as channels_ok,
  (select count(*) from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname in
     ('usage_heartbeat','my_usage','bump_message_count','label_asset',
      'submit_guardian_request','guardian_status','claim_notice','my_sessions_count')) = 8
                                                                          as functions_ok,
  -- 监护人通道必须允许匿名提交（监护人可能没有账号）
  (select has_function_privilege('anon','public.submit_guardian_request(text,text,text,text)','execute')) = true
                                                                          as guardian_anon_ok,
  -- 但请求明细表本身任何人都不能直接读
  (select count(*) from pg_catalog.pg_policies
     where schemaname='public' and tablename='guardian_requests') = 0     as guardian_table_locked,
  (select relrowsecurity from pg_class where oid='public.usage_daily'::regclass) = true
                                                                          as usage_rls_on,
  (select has_function_privilege('authenticated','public.label_asset(text,text,text,text)','execute')) = true
                                                                          as label_available;
