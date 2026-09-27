/**
 * functions/extract — 记忆抽取 worker（异步队列的消费端）
 *
 * 链路（docs/分册-后端与数据库.md §6.2、任务 3-4 / 3-5）：
 *   chat 流结束投 extract_jobs → 本函数扫 pending → 取窗口内消息
 *   → 小模型抽 {kind, text, salience} → 批量算 embedding → find_near_duplicate 合并
 *   → 写 memories + memory_links → 任务置 done
 *
 * 三条不能省：
 *   1. **幂等**：pending→running→done 三态 + attempts 上限 3。
 *      领取用条件更新（只有把 pending 改成 running 的那次调用算抢到），
 *      所以两个 cron 重叠跑也不会重复抽取 —— 重复抽取的代价是同一件事存两遍。
 *   2. **embedding 拿不到就只存文本**，绝不整体失败。库里 embedding 可空、
 *      recall() 的关键词通道本来就是为这种情况留的。
 *   3. **抽取用的是平台内置模型，成本记在平台头上** ⇒ 必须限频限量：
 *      每次运行最多 BATCH 个任务、每任务最多 MAX_MSGS 条消息。
 *
 * ★ 隐私边界：抽取结果只进该用户自己的 memories；对话内容一律不用于训练
 *   （docs/legal/14-训练数据使用政策.md）。日志只写 id 与计数，不写正文。
 */
import { admin, brief, json, ok, preflight, requireCron, safe } from '../_shared/http.ts';
import { builtinProfile } from '../_shared/providers/index.ts';
import { EGRESS, REDIRECT_POLICY } from '../_shared/ssrf.ts';
import { embedAvailable, embedTexts, literalFor } from '../_shared/embed.ts';
import { bumpHits, inspect } from '../_shared/moderation.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const BATCH = 8;               // 一次运行处理的任务数
const MAX_MSGS = 40;           // 单任务回看的消息数（约等于"每 8 轮"）
const MAX_ATTEMPTS = 3;        // 超过就不再重试，留在 failed 里等人工看
const STALE_RUNNING_MS = 10 * 60_000;  // running 超这个时长视为上次崩了，可回收
const EXTRACT_MAX_TOKENS = 600;        // 抽取输出很小：一段 JSON

interface Job {
  id: number;
  user_id: string;
  session_id: string;
  character_id: string;
  window_start: string | null;
  window_end: string | null;
  attempts: number;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return json(405, { error: 'METHOD_NOT_ALLOWED' });
  if (!requireCron(req)) return json(403, { error: 'FORBIDDEN' });

  const db = admin() as unknown as SupabaseClient;

  let model;
  try {
    model = builtinProfile();
  } catch (e) {
    // 没配 DEEPSEEK_API_KEY：抽取整条链路停摆，但不报错给 cron 平台（会疯狂重试）
    console.warn('[extract] 内置模型未配置', safe(e));
    return ok({ ok: false, reason: 'MODEL_NOT_CONFIGURED', processed: 0 });
  }

  await reclaimStale(db);

  const jobs = await claimJobs(db);
  const stats = { claimed: jobs.length, done: 0, failed: 0, memories: 0, merged: 0, vectors: 0, skipped: 0 };

  for (const job of jobs) {
    try {
      const r = await runJob(db, model, job);
      stats.done++;
      stats.memories += r.stored;
      stats.merged += r.merged;
      stats.vectors += r.vectorized;
    } catch (e) {
      stats.failed++;
      await markFailed(db, job, e);
      console.warn('[extract] job failed', job.id, safe(e));
    }
  }

  return ok({ ok: true, ...stats, embedding: embedAvailable() });
});

// ─── 领取（幂等的核心）────────────────────────────────────
/**
 * 条件更新当锁用：只有 status 仍是 pending 时才改得动，
 * 改到了才算抢到。Supabase 没有 SELECT FOR UPDATE SKIP LOCKED 的 js 写法，
 * 这一句 `.eq('status','pending')` 就是它的等价物。
 */
async function claimJobs(db: SupabaseClient): Promise<Job[]> {
  const { data: candidates } = await db.from('extract_jobs')
    .select('id,user_id,session_id,character_id,window_start,window_end,attempts,status')
    .eq('status', 'pending')
    .lt('attempts', MAX_ATTEMPTS)
    .order('created_at', { ascending: true })
    .limit(BATCH);

  const claimed: Job[] = [];
  for (const c of candidates ?? []) {
    const { data: won } = await db.from('extract_jobs')
      .update({ status: 'running', updated_at: new Date().toISOString() })
      .eq('id', c.id).eq('status', 'pending').select('id').maybeSingle();
    if (won) claimed.push(c as Job);
  }
  return claimed;
}

/** 上次崩在中途留下的 running：超时后放回 pending，否则一条坏任务能永久堵住队列 */
async function reclaimStale(db: SupabaseClient) {
  const cutoff = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
  const { error } = await db.from('extract_jobs')
    .update({ status: 'pending', updated_at: new Date().toISOString() })
    .eq('status', 'running').lt('updated_at', cutoff);
  if (error) console.warn('[extract] reclaim failed', safe(error.message));
}

// ─── 单个任务 ────────────────────────────────────────────
interface JobResult { stored: number; merged: number; vectorized: number }

async function runJob(db: SupabaseClient, profile: ReturnType<typeof builtinProfile>, job: Job): Promise<JobResult> {
  const messages = await loadWindow(db, job);
  if (messages.length < 2) {
    // 窗口里没有足够上下文就别硬抽（一句"好"抽不出任何事实）
    await finish(db, job, 'done', null);
    return { stored: 0, merged: 0, vectorized: 0 };
  }

  const extracted = await extractWithModel(profile, messages);
  if (!extracted.length) {
    await finish(db, job, 'done', null);
    return { stored: 0, merged: 0, vectorized: 0 };
  }

  // 批量算向量：一次 HTTP 一批，而不是逐条调（验收 V3-10）
  const texts = extracted.map((c) => c.text);
  const embedded = await embedTexts(texts);   // 永不抛错

  let stored = 0, merged = 0, vectorized = 0;
  const sourceIds = messages.map((m) => m.id).filter(isUuid);

  for (const cand of extracted) {
    // 抽取产物也是模型生成文本：过一遍 proactive scope 的规则再入库，
    // 免得被投毒的对话把违规内容固化成长期记忆
    const verdict = await inspect(db, cand.text, 'proactive');
    if (verdict.ruleIds.length) await bumpHits(db, verdict.ruleIds);
    if (!verdict.clean && verdict.action === 'block') continue;

    const vecLiteral = literalFor(embedded, cand.text);
    if (vecLiteral) vectorized++;

    const dupId = await findDuplicate(db, job, vecLiteral, cand.text);
    if (dupId) {
      merged++;
      await linkSources(db, dupId, sourceIds);
      continue;
    }

    const memId = await insertMemory(db, job, cand, vecLiteral, sourceIds);
    if (memId) stored++;
  }

  await finish(db, job, 'done', null);
  return { stored, merged, vectorized };
}

async function loadWindow(db: SupabaseClient, job: Job) {
  let q = db.from('messages')
    .select('id,role,content,created_at')
    .eq('session_id', job.session_id)
    .eq('user_id', job.user_id)          // ★ 双保险：会话与用户都要对得上
    .in('role', ['user', 'assistant'])
    .order('created_at', { ascending: false })
    .limit(MAX_MSGS);

  if (job.window_start) q = q.gte('created_at', job.window_start);
  if (job.window_end) q = q.lte('created_at', job.window_end);

  const { data } = await q;
  return (data ?? []).reverse();
}

// ─── 抽取提示 ────────────────────────────────────────────
interface Candidate { kind: 'fact' | 'episode'; text: string; salience: number }

/**
 * ★ 这段 prompt 只做一件事：从对话里挑事实。
 *   它不带人设、不带前缀缓存诉求（一次性任务，击穿缓存无所谓），
 *   更不含任何"绕过内容过滤"的指令 —— 抽取器看到的都是已过审的用户对话。
 */
const SYSTEM_EXTRACT = [
  '你是对话信息抽取器。输入是用户与其陪伴角色的一段对话。',
  '只抽取关于**用户本人**的稳定信息与值得记住的片段：',
  '· fact：可长期复用的事实（姓名、职业、家人、住址城市、作息、偏好、约定、重要日期）。',
  '· episode：一次具体的事件或情绪转折（发生了什么、他当时怎么说的）。',
  '规则：',
  '1. 每条不超过 60 字，用第三人称陈述句，不要引号。',
  '2. 只写对话里明确出现的内容，不做推测、不做心理分析、不给建议。',
  '3. 寒暄、语气词、角色自己说的话不算用户的事实，不要抽。',
  '4. 疑似真实证件号、完整银行卡号、密码类内容一律不抽。',
  '5. 没有可抽的就返回 {"items":[]}。',
  '只输出 JSON：{"items":[{"kind":"fact"|"episode","text":"...","salience":0到1}]}',
].join('\n');

async function extractWithModel(
  profile: ReturnType<typeof builtinProfile>,
  messages: Array<{ role: string; content: string }>,
): Promise<Candidate[]> {
  const transcript = messages
    .map((m) => `${m.role === 'user' ? '用户' : 'TA'}：${clip(m.content, 400)}`)
    .join('\n');

  // 内置模型走 OpenAI 兼容协议（_shared/providers/deepseek.ts 同源），
  // 抽取是一次性任务：不流式、不打缓存点，省掉整段前缀拼装。
  const res = await fetch(`${profile.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${profile.apiKey}`,
      accept: 'application/json',
    },
    body: JSON.stringify({
      model: profile.model,
      messages: [
        { role: 'system', content: SYSTEM_EXTRACT },
        { role: 'user', content: `对话：\n${transcript}\n\n请输出 JSON。` },
      ],
      stream: false,
      max_tokens: EXTRACT_MAX_TOKENS,
      temperature: 0,
    }),
    redirect: REDIRECT_POLICY,
    signal: timeout(EGRESS.connectTimeoutMs + EGRESS.firstByteTimeoutMs),
  });

  if (!res.ok) throw new Error(`extract upstream ${res.status}`);

  const jsonBody = await res.json().catch(() => null);
  return parseCandidates(pickText(jsonBody));
}

/** OpenAI 兼容的非流式响应读 choices[0].message.content */
function pickText(j: any): string {
  const c = j?.choices?.[0]?.message?.content;
  return typeof c === 'string' ? c : '';
}

/**
 * 从模型输出里抠出 items。
 * 容忍三种形态：纯 JSON / ```json 包裹 / 前后带解释文字。
 * 夹取：kind 白名单、文本长度、salience 落 0~1、条数上限。
 */
function parseCandidates(raw: string): Candidate[] {
  const s = String(raw ?? '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return [];

  let parsed: any;
  try {
    parsed = JSON.parse(s.slice(start, end + 1));
  } catch {
    return [];
  }

  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const it of items.slice(0, 12)) {
    const kind = it?.kind === 'episode' ? 'episode' : it?.kind === 'fact' ? 'fact' : null;
    const text = String(it?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!kind || text.length < 4) continue;
    if (looksLikeCredentialLeak(text)) continue;

    const n = Number(it?.salience);
    const salience = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
    const key = `${kind}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, text, salience });
  }
  return out;
}

/** 抽取器不许把凭据类内容写进长期记忆（即使提示里已经劝过模型别这么干） */
function looksLikeCredentialLeak(text: string): boolean {
  return /(1[3-9]\d{9})|(\d{17}[\dXx])|(\bsk-[A-Za-z0-9_-]{8,})|(\d{13,19})/.test(text);
}

// ─── 落库 ────────────────────────────────────────────────
/**
 * 近重复判定。有向量走 find_near_duplicate（阈值 0.92 与库侧默认一致）；
 * 没向量时退化为"同角色下同文本不重复存"的精确判重 —— 
 * 这是降级不是替代：文本判重抓不到"换了个说法"的重复。
 */
async function findDuplicate(db: SupabaseClient, job: Job, vecLiteral: string | null, text: string): Promise<string | null> {
  if (vecLiteral) {
    try {
      const { data } = await db.rpc('find_near_duplicate', {
        p_user: job.user_id, p_char: job.character_id, p_vec: vecLiteral, p_threshold: 0.92,
      });
      const id = typeof data === 'string' ? data : null;
      if (id) return id;
    } catch (e) {
      console.warn('[extract] near-duplicate check degraded', safe(e));
    }
  }
  const { data } = await db.from('memories')
    .select('id').eq('user_id', job.user_id).eq('character_id', job.character_id)
    .eq('text', text).is('invalidated_at', null).limit(1).maybeSingle();
  return data?.id ?? null;
}

async function insertMemory(
  db: SupabaseClient, job: Job, cand: Candidate, vecLiteral: string | null, sourceIds: string[],
): Promise<string | null> {
  const row: Record<string, unknown> = {
    user_id: job.user_id,
    character_id: job.character_id,
    session_id: job.session_id,
    kind: cand.kind,
    text: cand.text,
    salience: cand.salience.toFixed(3),
    source_msg_ids: sourceIds,
  };
  if (vecLiteral) row.embedding = vecLiteral;   // 没向量就干脆不写这一列，让它留 null

  const { data, error } = await db.from('memories').insert(row).select('id').single();
  if (error || !data) {
    console.warn('[extract] memory insert failed', safe(error?.message));
    return null;
  }
  await linkSources(db, data.id, sourceIds);
  return data.id;
}

/** 溯源表：删消息要让相关记忆失效（005 的触发器靠这张表找关联） */
async function linkSources(db: SupabaseClient, memoryId: string, messageIds: string[]) {
  const wanted = Array.from(new Set(messageIds.filter(isUuid)));
  if (!wanted.length) return;

  // 先读已存在的，只补缺的那部分 ⇒ 近重复合并时同一条被反复 link 也不会插出重复行
  const { data: existing } = await db.from('memory_links')
    .select('message_id').eq('memory_id', memoryId).in('message_id', wanted);
  const have = new Set((existing ?? []).map((r: any) => String(r.message_id)));
  const missing = wanted.filter((m) => !have.has(m));
  if (!missing.length) return;

  const { error } = await db.from('memory_links')
    .insert(missing.map((m) => ({ memory_id: memoryId, message_id: m })));
  if (error) console.warn('[extract] link insert failed', safe(error.message));
}

async function finish(db: SupabaseClient, job: Job, status: 'done' | 'failed', err: unknown) {
  await db.from('extract_jobs').update({
    status,
    last_error: err ? brief(err, 200) : null,
    updated_at: new Date().toISOString(),
  }).eq('id', job.id);
}

/** attempts+1；到上限就落 failed，否则退回 pending 让下一轮再试 */
async function markFailed(db: SupabaseClient, job: Job, err: unknown) {
  const attempts = (job.attempts ?? 0) + 1;
  await db.from('extract_jobs').update({
    status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
    attempts,
    last_error: brief(err, 200),
    updated_at: new Date().toISOString(),
  }).eq('id', job.id);
}

function clip(s: unknown, max: number): string {
  return String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').slice(0, max);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

function timeout(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}
