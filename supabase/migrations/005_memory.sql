-- 005_memory.sql
-- 长期记忆：pgvector 向量 + tsvector 关键词 混合检索
-- 见 docs/分册-后端与数据库.md §6、docs/HANDOFF.md §5-C3/G3
--
-- 设计要点：
--   · 存"抽取后的事实句"与"片段"，不整段存原文（喂给模型的密度更高、token 更省）
--   · 向量召回 + 关键词召回并联，过量召回后融合打分
--   · 召回结果注入 prompt 的"动态段 1"，绝不进静态前缀（否则击穿提示词缓存）
--   · 删消息必须让相关记忆失效（溯源完整性）

-- ─── 记忆主表 ────────────────────────────────────────────
create table if not exists public.memories (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  character_id     uuid not null references public.characters(id) on delete cascade,
  session_id       uuid references public.sessions(id) on delete set null,
  kind             public.mem_kind not null,
  text             text not null,
  embedding        vector(1024),
  -- 中文分词用 simple（不依赖词典扩展），模糊匹配靠 pg_trgm。
  -- 二期若要更准可上 zhparser，但需自建镜像，先用 simple + trgm 拿数据说话。
  tsv              tsvector generated always as (to_tsvector('simple', text)) stored,
  salience         numeric(4,3) not null default 0.500 check (salience between 0 and 1),
  source_msg_ids   uuid[] not null default '{}',
  recalled_count   int not null default 0,
  last_recalled_at timestamptz,
  invalidated_at   timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists idx_mem_scope on public.memories(user_id, character_id)
  where invalidated_at is null;
create index if not exists idx_mem_tsv   on public.memories using gin(tsv);
create index if not exists idx_mem_trgm  on public.memories using gin(text gin_trgm_ops);
-- HNSW：召回质量与构建成本折中；查询期 ef_search 由会话级设置（默认 40）
create index if not exists idx_mem_vec on public.memories
  using hnsw(embedding vector_cosine_ops) with (m = 16, ef_construction = 64);

-- ─── 溯源：记忆 ↔ 消息 ───────────────────────────────────
create table if not exists public.memory_links (
  memory_id  uuid not null references public.memories(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  primary key (memory_id, message_id)
);
create index if not exists idx_memlink_msg on public.memory_links(message_id);

-- ─── 养成：内层数值（零读）+ 外层阶段（可读）─────────────
create table if not exists public.affinity_state (
  session_id   uuid not null references public.sessions(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  score        numeric(8,2) not null default 0,
  signals      jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now(),
  primary key (session_id, character_id)
);

create table if not exists public.relationship_stage (
  session_id   uuid not null references public.sessions(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  stage        public.stage_t not null default 'stranger',
  changed_at   timestamptz not null default now(),
  primary key (session_id, character_id)
);

-- 004 的 do 块在这两张表建立之前跑过，故此处补建策略（幂等）
alter table public.affinity_state    enable row level security;
alter table public.relationship_stage enable row level security;

drop policy if exists p_affinity_deny on public.affinity_state;
create policy p_affinity_deny on public.affinity_state
  for select to authenticated using (false);

drop policy if exists p_stage_read on public.relationship_stage;
create policy p_stage_read on public.relationship_stage
  for select to authenticated using (
    exists (select 1 from public.sessions s
             where s.id = relationship_stage.session_id and s.user_id = auth.uid())
  );

-- ─── 抽取任务队列（异步，不阻塞对话响应）─────────────────
create table if not exists public.extract_jobs (
  id           bigint generated always as identity primary key,
  user_id      uuid not null,
  session_id   uuid not null,
  character_id uuid not null,
  status       text not null default 'pending'
                 check (status in ('pending','running','done','failed')),
  window_start timestamptz,
  window_end   timestamptz,
  attempts     int not null default 0,
  last_error   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_extract_pending on public.extract_jobs(status, created_at)
  where status = 'pending';

-- ─── salience 加成 ──────────────────────────────────────
-- fact 优先（人名/日期/约定这类必须捞到）；近期被召回过的轻微加权
create or replace function public.salience_bonus(
  p_kind public.mem_kind, p_salience numeric, p_last_recalled timestamptz
) returns numeric language sql immutable set search_path = pg_catalog, public as $fn$
  select round((
    case p_kind
      when 'fact'     then 0.10
      when 'episode'  then 0.03
      when 'summary'  then 0.00
    end
    + coalesce(p_salience, 0.5) * 0.06
    + case
        when p_last_recalled is null then 0
        when p_last_recalled > now() - interval '3 days' then 0.02
        else 0
      end
  )::numeric, 4);
$fn$;

-- ─── 混合检索 ────────────────────────────────────────────
-- 权重 0.65 / 0.35 是起点，必须用 100 条标注查询调参（任务 3-10）
create or replace function public.recall(
  p_user uuid,
  p_char uuid,
  p_query text,
  p_vec vector(1024),
  p_topk int default 8
) returns table (
  id uuid, kind public.mem_kind, text text,
  score numeric, vec_score numeric, kw_score numeric,
  source_msg_ids uuid[]
) language sql stable set search_path = pg_catalog, public as $fn$
  with base as (
    select m.*
      from public.memories m
     where m.user_id = p_user
       and m.character_id = p_char
       and m.invalidated_at is null
  ),
  v as (
    select b.id, b.kind, b.text, b.source_msg_ids,
           1 - (b.embedding <=> p_vec) as vec_score
      from base b
     where b.embedding is not null
     order by b.embedding <=> p_vec
     limit p_topk * 4                       -- 先过量召回，融合后再截断
  ),
  k as (
    -- ★ 中文兜底通道。to_tsvector('simple') 不分词，整句会被当成**一个** token，
    --   所以「用户喜欢吃火锅」检索「火锅」时 tsv @@ ... 匹配不上。
    --   原实现只有 `like p_query || '%'` 前缀匹配，中串同样漏召回。
    --   这里补子串 ILIKE，配合上面的 gin(text gin_trgm_ops) 索引可走索引扫描。
    select b.id, b.kind, b.text, b.source_msg_ids,
           ts_rank(b.tsv, websearch_to_tsquery('simple', p_query))
           + similarity(lower(b.text), lower(p_query)) * 0.3 as kw_score
      from base b
     where b.tsv @@ websearch_to_tsquery('simple', p_query)
        or lower(b.text) like lower(p_query) || '%'
        or lower(b.text) like '%' || lower(p_query) || '%'
     limit p_topk * 4
  ),
  u as (
    select id, kind, text, source_msg_ids,
           max(vec_score) as vec_score,
           max(kw_score)  as kw_score
      from (
        select id, kind, text, source_msg_ids, vec_score, null::numeric as kw_score  from v
        union all
        select id, kind, text, source_msg_ids, null::numeric as vec_score, kw_score from k
      ) t
     group by id, kind, text, source_msg_ids
  ),
  scored as (
    select u.id, u.kind, u.text, u.source_msg_ids,
           coalesce(u.vec_score, 0) as vec_score,
           coalesce(u.kw_score, 0)  as kw_score,
           ( coalesce(u.vec_score, 0) * 0.65
           + coalesce(u.kw_score, 0)  * 0.35
           + public.salience_bonus(u.kind, b.salience, b.last_recalled_at)
           ) as score
      from u
      join base b on b.id = u.id
  )
  select id, kind, text, round(score::numeric, 4), vec_score, kw_score, source_msg_ids
    from scored
   order by score desc
   limit p_topk;
$fn$;

-- 召回后回写统计（用于 salience 衰减与看板）
create or replace function public.mark_recalled(p_ids uuid[])
returns void language sql volatile set search_path = pg_catalog, public as $fn$
  update public.memories
     set recalled_count = recalled_count + 1,
         last_recalled_at = now()
   where id = any (p_ids);
$fn$;

-- ─── 近重复检测：同一事实不重复存 ────────────────────────
create or replace function public.find_near_duplicate(
  p_user uuid, p_char uuid, p_vec vector(1024), p_threshold numeric default 0.92
) returns uuid language sql stable set search_path = pg_catalog, public as $fn$
  select m.id
    from public.memories m
   where m.user_id = p_user
     and m.character_id = p_char
     and m.invalidated_at is null
     and m.embedding is not null
     and 1 - (m.embedding <=> p_vec) >= p_threshold
   order by m.embedding <=> p_vec
   limit 1;
$fn$;

-- ─── 删消息 ⇒ 相关记忆失效（溯源完整性，任务 3-7）────────
create or replace function public.invalidate_memories_for_messages()
returns trigger language plpgsql set search_path = pg_catalog, public as $fn$
declare
  v_orphan uuid[];
begin
  -- 经 memory_links 找
  update public.memories m
     set invalidated_at = now()
   where m.invalidated_at is null
     and exists (
       select 1 from public.memory_links l
        where l.memory_id = m.id and l.message_id = old.id
     );

  -- 经 source_msg_ids 数组找（批量导入时可能只有数组）
  update public.memories m
     set invalidated_at = now()
   where m.invalidated_at is null
     and old.id = any (m.source_msg_ids);

  -- 若某条记忆的溯源已全部消失，则失效（避免"无源记忆"）
  select array_agg(m.id) into v_orphan
    from public.memories m
   where m.invalidated_at is null
     and cardinality(m.source_msg_ids) > 0
     and not exists (
       select 1 from public.messages msg
        where msg.id = any (m.source_msg_ids)
     );

  if v_orphan is not null then
    update public.memories set invalidated_at = now() where id = any (v_orphan);
  end if;

  return old;
end;
$fn$;

drop trigger if exists trg_invalidate_memory on public.messages;
create trigger trg_invalidate_memory
  after delete on public.messages
  for each row execute function public.invalidate_memories_for_messages();

-- ─── 受控删除入口（RLS 不给 messages 的 delete 策略，走这里）
create or replace function public.delete_message(p_id uuid)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $fn$
begin
  if auth.uid() is null then return false; end if;
  delete from public.messages where id = p_id and user_id = auth.uid();
  return found;
end;
$fn$;

create or replace function public.delete_session(p_id uuid)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $fn$
begin
  if auth.uid() is null then return false; end if;
  delete from public.messages  where session_id = p_id and user_id = auth.uid();
  delete from public.sessions  where id = p_id and user_id = auth.uid();
  return found;
end;
$fn$;

-- 记忆删除需同时清向量与溯源，且必须属于本人
create or replace function public.delete_memory(p_id uuid)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $fn$
begin
  if auth.uid() is null then return false; end if;
  delete from public.memories where id = p_id and user_id = auth.uid();
  return found;
end;
$fn$;

grant execute on function public.delete_message(uuid)   to authenticated;
grant execute on function public.delete_session(uuid)   to authenticated;
grant execute on function public.delete_memory(uuid)    to authenticated;
grant execute on function public.recall(uuid,uuid,text,vector,int) to authenticated;
grant execute on function public.salience_bonus(public.mem_kind,numeric,timestamptz) to authenticated;

-- ─── 自检 ───────────────────────────────────────────────
select
  (select count(*) from pg_catalog.pg_tables
     where schemaname='public' and tablename in
     ('memories','memory_links','affinity_state','relationship_stage','extract_jobs')) = 5
                                                                            as tables_ok,
  (select count(*) from pg_catalog.pg_indexes
     where tablename='memories' and indexname in
     ('idx_mem_scope','idx_mem_tsv','idx_mem_trgm','idx_mem_vec')) = 4     as indexes_ok,
  (select count(*) from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname in
     ('salience_bonus','recall','mark_recalled','find_near_duplicate',
      'invalidate_memories_for_messages','delete_message','delete_session','delete_memory')) = 8
                                                                            as functions_ok,
  (select count(*) from pg_catalog.pg_attribute
     where attrelid='public.memories'::regclass and attname='tsv'
       and attgenerated = 's') = 1                                          as tsv_generated_ok,
  (select count(*) from pg_catalog.pg_trigger t
     join pg_catalog.pg_class c on c.oid=t.tgrelid
    where c.relname='messages' and t.tgname='trg_invalidate_memory'
      and not t.tgisinternal) = 1                                           as invalidate_trigger_ok,
  (select count(*) from pg_catalog.pg_policies
     where schemaname='public' and tablename='affinity_state') = 1          as affinity_deny_ok,
  (select public.salience_bonus('fact', 0.9, null)) >
   (select public.salience_bonus('summary', 0.9, null))                     as fact_outranks_summary_ok;
