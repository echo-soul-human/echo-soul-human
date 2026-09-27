-- 008_rpc_core.sql
-- 业务 RPC：会话、角色、表情包、记忆、好感度、主动关怀、分享、规则计数
-- 全部 security definer + 显式 search_path；权限一律按"只能操作自己的行"设计。
-- 幂等：可重复执行。

-- ─── 规则命中计数 ───────────────────────────────────────
create or replace function public.bump_rule_hits(p_ids bigint[])
returns void language sql volatile security definer set search_path = pg_catalog, public as $fn$
  update public.sensitive_rules set hits = hits + 1 where id = any (p_ids);
$fn$;
revoke execute on function public.bump_rule_hits(bigint[]) from public, anon, authenticated;

-- ─── 会话列表（带最后一条消息与未读）────────────────────
create or replace function public.list_sessions()
returns table (
  id uuid, kind text, title text, last_msg_at timestamptz,
  pinned_at timestamptz, archived_at timestamptz,
  character_ids uuid[], character_names text[],
  preview text, unread int
)
language sql stable security definer set search_path = pg_catalog, public as $fn$
  with mine as (
    select s.id, s.kind, s.title, s.last_msg_at, s.pinned_at, s.archived_at, s.unread_base
      from public.sessions s
     where s.user_id = auth.uid()
  ),
  chars as (
    select m.session_id,
           array_agg(c.id order by m.seat) as ids,
           array_agg(c.name order by m.seat) as names
      from public.session_members m
      join public.characters c on c.id = m.character_id
     where m.session_id in (select id from mine)
     group by m.session_id
  ),
  last as (
    select distinct on (msg.session_id) msg.session_id, msg.content, msg.role, msg.created_at
      from public.messages msg
     where msg.session_id in (select id from mine)
     order by msg.session_id, msg.created_at desc
  ),
  unread as (
    select msg.session_id, count(*)::int as n
      from public.messages msg
     where msg.session_id in (select id from mine)
       and msg.role = 'assistant'
       and msg.read_at is null
     group by msg.session_id
  )
  select m.id, m.kind, m.title, m.last_msg_at, m.pinned_at, m.archived_at,
         coalesce(c.ids, '{}'), coalesce(c.names, '{}'),
         left(coalesce(l.content, ''), 80),
         coalesce(u.n, 0)
    from mine m
    left join chars c on c.session_id = m.id
    left join last l on l.session_id = m.id
    left join unread u on u.session_id = m.id
   order by m.pinned_at desc nulls last, m.last_msg_at desc nulls last;
$fn$;
grant execute on function public.list_sessions() to authenticated;

-- ─── 开会话（复用已有，避免每次点击都新建）──────────────
create or replace function public.open_session(p_character uuid)
returns uuid language plpgsql volatile security definer set search_path = pg_catalog, public as $fn$
declare
  v_uid uuid := auth.uid();
  v_sid uuid;
  v_greeting text;
  v_name text;
begin
  if v_uid is null then raise exception 'UNAUTHORIZED'; end if;
  if not exists (select 1 from public.characters c
                  where c.id = p_character
                    and (c.owner_id is null or c.owner_id = v_uid
                         or (c.visibility = 'public' and c.review_status = 'approved'))) then
    raise exception 'CHARACTER_NOT_AVAILABLE';
  end if;

  -- 已有含该角色的会话就复用（只复用单聊，群聊不自动复用）
  select m.session_id into v_sid
    from public.session_members m
    join public.sessions s on s.id = m.session_id
   where m.character_id = p_character and s.user_id = v_uid and s.kind = 'solo'
     and s.archived_at is null
   order by s.last_msg_at desc nulls last limit 1;

  if v_sid is not null then
    update public.sessions set last_msg_at = coalesce(last_msg_at, now()) where id = v_sid;
    return v_sid;
  end if;

  insert into public.sessions (user_id, kind) values (v_uid, 'solo') returning id into v_sid;
  insert into public.session_members (session_id, character_id, seat) values (v_sid, p_character, 1);

  select greeting, name into v_greeting, v_name
    from public.characters where id = p_character;
  if coalesce(v_greeting, '') <> '' then
    insert into public.messages (session_id, user_id, role, character_id, content, origin)
      values (v_sid, v_uid, 'assistant', p_character, v_greeting, 'imported');
  end if;

  return v_sid;
end;
$fn$;
grant execute on function public.open_session(uuid) to authenticated;

-- ─── 建群（成员数按档位夹，服务端判）────────────────────
create or replace function public.create_group(
  p_character_ids uuid[], p_title text default null, p_carry int default null
) returns uuid language plpgsql volatile security definer set search_path = pg_catalog, public as $fn$
declare
  v_uid uuid := auth.uid();
  v_sid uuid;
  v_max int;
  v_id uuid;
  v_seat int := 0;
begin
  if v_uid is null then raise exception 'UNAUTHORIZED'; end if;
  select group_member_max into v_max from public.entitlements where user_id = v_uid;
  v_max := coalesce(v_max, 2);
  if cardinality(p_character_ids) < 2 then raise exception 'NEED_TWO_MEMBERS'; end if;
  if cardinality(p_character_ids) > v_max then
    raise exception 'GROUP_LIMIT_%', v_max;
  end if;

  insert into public.sessions (user_id, kind, title, carry_tokens)
    values (v_uid, 'group', left(coalesce(p_title, ''), 60),
            case when p_carry is null then null else greatest(1024, least(p_carry, 524288)) end)
    returning id into v_sid;

  foreach v_id in array p_character_ids loop
    v_seat := v_seat + 1;
    if not exists (select 1 from public.characters c
                    where c.id = v_id
                      and (c.owner_id is null or c.owner_id = v_uid
                           or (c.visibility = 'public' and c.review_status = 'approved'))) then
      raise exception 'CHARACTER_NOT_AVAILABLE';
    end if;
    insert into public.session_members (session_id, character_id, seat) values (v_sid, v_id, v_seat);
  end loop;

  return v_sid;
end;
$fn$;
grant execute on function public.create_group(uuid[], text, int) to authenticated;

-- ─── 会话改名 / 归档 / 置顶 ─────────────────────────────
create or replace function public.patch_session(
  p_id uuid, p_title text default null, p_archived boolean default null,
  p_pinned boolean default null, p_carry int default null
) returns boolean language plpgsql volatile security definer set search_path = pg_catalog, public as $fn$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return false; end if;
  if not exists (select 1 from public.sessions where id = p_id and user_id = v_uid) then
    return false;
  end if;

  update public.sessions s set
    title        = coalesce(nullif(p_title, ''), s.title),
    archived_at  = case when p_archived is null then s.archived_at
                        when p_archived then coalesce(s.archived_at, now()) else null end,
    pinned_at    = case when p_pinned is null then s.pinned_at
                        when p_pinned then coalesce(s.pinned_at, now()) else null end,
    carry_tokens = case when p_carry is null then s.carry_tokens
                        else greatest(1024, least(p_carry,
                          (select carry_tokens from public.entitlements where user_id = v_uid))) end
   where s.id = p_id;
  return true;
end;
$fn$;
grant execute on function public.patch_session(uuid, text, boolean, boolean, int) to authenticated;

-- ─── 消息已读（多端不再重复提醒，验收 V5-33）─────────────
create or replace function public.mark_read(p_session uuid)
returns int language plpgsql volatile security definer set search_path = pg_catalog, public as $fn$
declare v_uid uuid := auth.uid(); v_n int;
begin
  if v_uid is null then return 0; end if;
  update public.messages set read_at = now()
   where session_id = p_session and user_id = v_uid
     and role = 'assistant' and read_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$fn$;
grant execute on function public.mark_read(uuid) to authenticated;

-- ─── 分页取消息（向上翻更早）────────────────────────────
create or replace function public.page_messages(
  p_session uuid, p_before timestamptz default null, p_limit int default 40
) returns table (id uuid, role msg_role, character_id uuid, content text,
                partial boolean, created_at timestamptz)
language sql stable security definer set search_path = pg_catalog, public as $fn$
  select m.id, m.role, m.character_id, m.content, m.partial, m.created_at
    from public.messages m
    join public.sessions s on s.id = m.session_id
   where m.session_id = p_session
     and s.user_id = auth.uid()
     and (p_before is null or m.created_at < p_before)
   order by m.created_at desc
   limit least(greatest(coalesce(p_limit, 40), 1), 200);
$fn$;
grant execute on function public.page_messages(uuid, timestamptz, int) to authenticated;

-- ─── 角色：创建 / 更新 / 发布 ───────────────────────────
create or replace function public.create_character(
  p_name text, p_tagline text default '', p_persona text default '',
  p_greeting text default '', p_examples jsonb default '[]'::jsonb
) returns uuid language plpgsql volatile security definer set search_path = pg_catalog, public as $fn$
declare
  v_uid uuid := auth.uid();
  v_cid uuid;
  v_slots int;
  v_used int;
begin
  if v_uid is null then raise exception 'UNAUTHORIZED'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'NAME_REQUIRED'; end if;

  select character_slots into v_slots from public.entitlements where user_id = v_uid;
  v_slots := coalesce(v_slots, 1);
  select count(*) into v_used from public.characters where owner_id = v_uid;
  if v_used >= v_slots then
    raise exception 'SLOT_LIMIT_%', v_slots;
  end if;

  insert into public.characters (owner_id, name, tagline, persona_text, greeting, example_dialogs)
    values (v_uid, left(trim(p_name), 24), left(coalesce(p_tagline,''), 300),
            left(coalesce(p_persona,''), 6000), left(coalesce(p_greeting,''), 200),
            coalesce(p_examples, '[]'::jsonb))
    returning id into v_cid;

  -- 隐藏锁由服务端按模板生成，用户永远读不到（character_locks 零读）
  insert into public.character_locks (character_id, lock_text, static_hash, anti_drift_reply, boundaries)
    values (v_cid,
            '你是' || left(trim(p_name), 24) || '。' || left(coalesce(p_persona,''), 6000),
            'pending',
            '我们不是在演，我就是' || left(trim(p_name), 24) || '。',
            '');

  insert into public.character_versions (character_id, version, persona_text, example_dialogs, behavior_notes)
    values (v_cid, 1, coalesce(p_persona,''), coalesce(p_examples,'[]'::jsonb), '');
  update public.characters set published_version = 1 where id = v_cid;

  return v_cid;
end;
$fn$;
grant execute on function public.create_character(text, text, text, text, jsonb) to authenticated;

create or replace function public.update_character(
  p_id uuid, p_name text default null, p_tagline text default null,
  p_persona text default null, p_greeting text default null,
  p_examples jsonb default null, p_avatar text default null,
  p_portrait text default null, p_voice text default null,
  p_emotion_portraits jsonb default null
) returns int language plpgsql volatile security definer set search_path = pg_catalog, public as $fn$
declare v_uid uuid := auth.uid(); v_new int;
begin
  if v_uid is null then raise exception 'UNAUTHORIZED'; end if;
  if not exists (select 1 from public.characters where id = p_id and owner_id = v_uid) then
    raise exception 'NOT_OWNER';
  end if;

  update public.characters set
    name            = coalesce(nullif(trim(coalesce(p_name, '')), ''), name),
    tagline         = case when p_tagline is null then tagline else left(p_tagline, 300) end,
    persona_text    = case when p_persona is null then persona_text else left(p_persona, 6000) end,
    greeting        = case when p_greeting is null then greeting else left(p_greeting, 200) end,
    example_dialogs = coalesce(p_examples, example_dialogs),
    avatar_path     = coalesce(p_avatar, avatar_path),
    portrait_path   = coalesce(p_portrait, portrait_path),
    voice_profile_id= coalesce(p_voice, voice_profile_id),
    emotion_portraits = coalesce(p_emotion_portraits, emotion_portraits),
    updated_at      = now()
   where id = p_id;

  -- 人设变了就写新版本并冻结旧版本：已发生的记忆不重写（架构 §4 规则 2）
  if p_persona is not null or p_examples is not null then
    select max(version) into v_new from public.character_versions where character_id = p_id;
    v_new := coalesce(v_new, 0) + 1;
    insert into public.character_versions (character_id, version, persona_text, example_dialogs, behavior_notes)
      select p_id, v_new, c.persona_text, c.example_dialogs, c.behavior_notes
        from public.characters c where c.id = p_id;
    update public.characters set published_version = v_new where id = p_id;

    update public.character_locks
       set lock_text = '你是' || (select name from public.characters where id = p_id) || '。'
                      || (select persona_text from public.characters where id = p_id),
           updated_at = now()
     where character_id = p_id;
  end if;

  return v_new;
end;
$fn$;
grant execute on function public.update_character(uuid, text, text, text, text, jsonb,
  text, text, text, jsonb) to authenticated;

-- 发布到广场：进审核队列，不直接公开（25 号专篇 §2.1）
create or replace function public.publish_character(p_id uuid, p_visibility text default 'public')
returns text language plpgsql volatile security definer set search_path = pg_catalog, public as $fn$
declare
  v_uid uuid := auth.uid();
  v_owner uuid; v_can_tier text; v_is_minor boolean;
begin
  if v_uid is null then return 'unauthorized'; end if;
  select owner_id into v_owner from public.characters where id = p_id;
  if v_owner is distinct from v_uid then return 'not_owner'; end if;

  -- 发布权限按档位判。注意 entitlements 表**没有** can_publish 列，
  -- 那一层是服务端 limits.ts 推导出来的；在这里直接查列会报 42703。
  select tier into v_can_tier from public.entitlements where user_id = v_uid;
  select coalesce(is_minor, false) into v_is_minor from public.entitlements where user_id = v_uid;
  if v_is_minor then return 'minors_blocked'; end if;
  if v_can_tier is null or v_can_tier not in ('pro','pro_plus','ultra') then
    return 'tier_too_low';
  end if;

  if exists (select 1 from public.characters c where c.id = p_id
              and c.visibility = 'public' and c.review_status = 'approved') then
    return 'approved';
  end if;

  insert into public.card_reviews (character_id, status) values (p_id, 'pending')
    on conflict (character_id) do update set status = 'pending', reviewed_at = now();
  update public.characters set visibility = p_visibility, review_status = 'pending' where id = p_id;
  return 'pending';
end;
$fn$;
grant execute on function public.publish_character(uuid, text) to authenticated;

-- ─── 表情包 ─────────────────────────────────────────────
create table if not exists public.sticker_packs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists public.stickers (
  id uuid primary key default gen_random_uuid(),
  pack_id uuid not null references public.sticker_packs(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  path text not null,
  caption text not null default '',
  token text not null unique,          -- [emoji:token] 里的标识
  created_at timestamptz not null default now()
);
create index if not exists idx_sticker_user on public.stickers(user_id);
alter table public.sticker_packs enable row level security;
alter table public.stickers enable row level security;
drop policy if exists p_sticker_own on public.sticker_packs;
create policy p_sticker_own on public.sticker_packs
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists p_sticker_item_own on public.stickers;
create policy p_sticker_item_own on public.stickers
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.add_stickers(
  p_pack uuid, p_name text, p_items jsonb
) returns int language plpgsql volatile security definer set search_path = pg_catalog, public as $fn$
declare
  v_uid uuid := auth.uid(); v_quota int; v_have int; v_added int := 0;
  v_item jsonb; v_pack uuid; v_token text;
begin
  if v_uid is null then raise exception 'UNAUTHORIZED'; end if;
  select sticker_quota into v_quota from public.entitlements where user_id = v_uid;
  v_quota := coalesce(v_quota, 20);
  select count(*) into v_have from public.stickers where user_id = v_uid;

  if p_pack is null then
    insert into public.sticker_packs (user_id, name)
      values (v_uid, left(coalesce(nullif(trim(p_name),''), '默认'), 40))
      returning id into v_pack;
  else
    v_pack := p_pack;
    if not exists (select 1 from public.sticker_packs where id = v_pack and user_id = v_uid) then
      raise exception 'NOT_OWNER';
    end if;
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    if v_have + v_added >= v_quota then exit; end if;
    if coalesce(v_item->>'path','') = '' then continue; end if;
    v_token := substr(md5(random()::text || clock_timestamp()::text), 1, 10);
    insert into public.stickers (pack_id, user_id, path, caption, token)
      values (v_pack, v_uid, v_item->>'path', left(coalesce(v_item->>'caption',''), 40), v_token);
    v_added := v_added + 1;
  end loop;

  return v_added;
end;
$fn$;
grant execute on function public.add_stickers(uuid, text, jsonb) to authenticated;

/** 供 chat 注入的可用表情清单（只给 caption，不给图，省 token） */
create or replace function public.sticker_catalog(p_session uuid)
returns table (token text, caption text)
language sql stable security definer set search_path = pg_catalog, public as $fn$
  select s.token, s.caption
    from public.stickers s
    join public.sticker_packs p on p.id = s.pack_id
    join public.sessions g on g.id = p_session
   where s.user_id = g.user_id and g.user_id = auth.uid() and p.enabled
   order by s.created_at
   limit 120;
$fn$;
grant execute on function public.sticker_catalog(uuid) to authenticated;

-- ─── 记忆：手动新增 / 修正 ──────────────────────────────
create or replace function public.add_memory(
  p_character uuid, p_session uuid, p_text text
) returns uuid language plpgsql volatile security definer set search_path = pg_catalog, public as $fn$
declare v_uid uuid := auth.uid(); v_id uuid; v_topk int;
begin
  if v_uid is null then raise exception 'UNAUTHORIZED'; end if;
  if coalesce(trim(p_text), '') = '' then raise exception 'EMPTY'; end if;
  select recall_topk into v_topk from public.entitlements where user_id = v_uid;

  insert into public.memories (user_id, character_id, session_id, kind, text, salience, manual)
    values (v_uid, p_character, p_session, 'fact', left(trim(p_text), 500), 0.950, true)
    returning id into v_id;
  return v_id;
end;
$fn$;
grant execute on function public.add_memory(uuid, uuid, text) to authenticated;

-- ─── 好感度与阶段（内层不可见，阶段一天最多变一次）──────
create or replace function public.bump_affinity(
  p_session uuid, p_character uuid, p_delta numeric, p_signal text default ''
) returns text language plpgsql volatile security definer set search_path = pg_catalog, public as $fn$
declare
  v_uid uuid; v_score numeric; v_new numeric; v_stage stage_t; v_old_stage stage_t; v_changed timestamptz;
begin
  select s.user_id into v_uid from public.sessions s where s.id = p_session;
  if v_uid is null then return 'none'; end if;

  insert into public.affinity_state (session_id, character_id) values (p_session, p_character)
    on conflict (session_id, character_id) do nothing;
  insert into public.relationship_stage (session_id, character_id) values (p_session, p_character)
    on conflict (session_id, character_id) do nothing;

  select score, stage, changed_at
    into v_score, v_old_stage, v_changed
    from public.affinity_state a
    join public.relationship_stage r using (session_id, character_id)
   where a.session_id = p_session and a.character_id = p_character;

  v_new := least(1200, greatest(0, coalesce(v_score, 0) + p_delta));
  update public.affinity_state
     set score = v_new,
         signals = signals || jsonb_build_object(p_signal, coalesce((signals->>p_signal)::int, 0) + 1),
         updated_at = now()
   where session_id = p_session and character_id = p_character;

  v_stage := case
    when v_new >= 900 then 'established'
    when v_new >= 500 then 'ambiguous'
    when v_new >= 240 then 'close'
    when v_new >= 80  then 'acquainted'
    else 'stranger' end;

  -- 跃迁节流：一天最多一次，半静态段稳定，提示词缓存才不会被反复击穿。
  -- ⚠ 必须放行"从初始 stranger 的第一次跃迁"：relationship_stage.changed_at 建行时
  --   就是 now()，不加这个例外会导致新用户**永远**停在 stranger（实测踩过）。
  if v_stage <> v_old_stage
     and (v_old_stage = 'stranger'
          or v_changed is null
          or v_changed < date_trunc('day', now())) then
    update public.relationship_stage
       set stage = v_stage, changed_at = now()
     where session_id = p_session and character_id = p_character;
    return v_stage;
  end if;
  return v_old_stage;
end;
$fn$;
revoke execute on function public.bump_affinity(uuid, uuid, numeric, text) from public, anon, authenticated;

-- ─── 主动关怀：排期与领取 ───────────────────────────────
create or replace function public.schedule_care(p_day date default current_date)
returns int language plpgsql volatile security definer set search_path = pg_catalog, public as $fn$
declare v_n int;
begin
  insert into public.proactive_jobs (user_id, character_id, session_id, kind, due_at, payload)
  select e.user_id, m.character_id, m.session_id, 'care',
         now() + interval '1 hour' * (random() * 8 + 3),
         jsonb_build_object('day', p_day::text, 'tier', e.tier)
    from public.entitlements e
    join public.session_members m on m.session_id in (
      select id from public.sessions where user_id = e.user_id and archived_at is null)
   where e.proactive_per_day > 0
     -- 频率门槛：lite 每周 1 次，其余按天。
     -- ⚠ 原来写成 "A and B or C and D"，优先级把 lite 的限制架空了；
     --   且 extract(weekday from timestamptz) 不是合法单位，应为 dow。
     and (
           (e.tier = 'lite' and extract(dow from now() at time zone 'UTC') in (1, 4))
           or e.tier <> 'lite'
         )
     and not exists (
       select 1 from public.proactive_jobs j
        where j.user_id = e.user_id and j.kind = 'care'
          and j.payload->>'day' = p_day::text)
   on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$fn$;
revoke execute on function public.schedule_care(date) from public, anon, authenticated;

-- ─── 分享链接：创建与访问 ───────────────────────────────
create or replace function public.create_share(
  p_session uuid, p_message_ids uuid[], p_visibility text default 'public'
) returns text language plpgsql volatile security definer set search_path = pg_catalog, public as $fn$
declare
  v_uid uuid := auth.uid(); v_code text; v_cnt int;
begin
  if v_uid is null then raise exception 'UNAUTHORIZED'; end if;
  if not exists (select 1 from public.sessions where id = p_session and user_id = v_uid) then
    raise exception 'NOT_OWNER';
  end if;
  -- 只能分享自己的会话，且最多 20 条（防整库外泄）
  select count(*) into v_cnt from public.messages
   where id = any (p_message_ids) and session_id = p_session and user_id = v_uid;
  if v_cnt = 0 then raise exception 'NO_MESSAGES'; end if;
  if v_cnt > 20 then raise exception 'TOO_MANY'; end if;

  -- 短码生成。⚠ 不要用 pgcrypto 的 gen_random_bytes：Supabase 把它装在 extensions
  -- schema，而本函数设了 search_path=pg_catalog,public，实测报"function does not exist"。
  -- md5 + random 只依赖 pg_catalog，取前 10 位已是 6e16 量级的空间。
  v_code := substr(md5(random()::text || clock_timestamp()::text), 1, 10);
  if v_code is null or length(v_code) < 10 then
    raise exception 'SHARE_CODE_GENERATION_FAILED';
  end if;

  insert into public.share_links (id, user_id, character_id, session_id, messages, visibility)
    select v_code, v_uid, m.character_id, p_session, p_message_ids, p_visibility
      from public.session_members m where m.session_id = p_session order by m.seat limit 1;
  return v_code;
end;
$fn$;
grant execute on function public.create_share(uuid, uuid[], text) to authenticated;

create or replace function public.resolve_share(p_code text)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, public as $fn$
declare r record; out_rows jsonb;
begin
  select * into r from public.share_links
   where id = p_code and (expires_at is null or expires_at > now());
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;

  update public.share_links set views = views + 1 where id = p_code;
  insert into public.share_visits (link_id, referrer, ua_class)
    values (p_code,
      coalesce(current_setting('request.headers', true)::jsonb ->> 'referer', ''), '');

  -- 只输出被用户显式勾选分享的那几条；刻意不含 user_id / session_id
  select jsonb_agg(jsonb_build_object(
           'role', m.role, 'content', left(m.content, 600), 'at', m.created_at)
           order by m.created_at)
    into out_rows
    from public.messages m
   where m.id = any (r.messages);

  return jsonb_build_object(
    'ok', true,
    'character', (select jsonb_build_object('id', c.id, 'name', c.name, 'avatar', c.avatar_path)
                    from public.characters c where c.id = r.character_id),
    'messages', coalesce(out_rows, '[]'::jsonb));
end;
$fn$;
grant execute on function public.resolve_share(text) to authenticated, anon;

-- ─── 自检 ───────────────────────────────────────────────
select
  (select count(*) from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in
     ('bump_rule_hits','list_sessions','open_session','create_group','patch_session',
      'mark_read','page_messages','create_character','update_character','publish_character',
      'add_stickers','sticker_catalog','add_memory','bump_affinity','schedule_care',
      'create_share','resolve_share')) = 17                                  as functions_ok,
  (select count(*) from pg_catalog.pg_tables where schemaname='public'
     and tablename in ('sticker_packs','stickers')) = 2                      as sticker_tables_ok,
  (select count(*) from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.prosecdef
      and p.proname in ('list_sessions','open_session','create_character','create_share')
      and p.proconfig is not null
      and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')) = 4
                                                                             as definer_guarded_ok,
  (select count(*) from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname in ('bump_affinity','schedule_care')
      and has_function_privilege('authenticated', p.oid, 'execute')) = 0     as internal_only_locked;
