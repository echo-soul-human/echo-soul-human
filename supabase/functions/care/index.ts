/**
 * functions/care — 主动关怀 cron（每 5 分钟一次，docs/架构与阶段划分.md §5.2）
 *
 * 顺序是硬性的，不能换：
 *   schedule_care 排期 → 领取到期任务 → **先落 messages** → 再尝试推送
 *   → 写回 proactive_jobs.message_id 与状态
 * 理由（docs/分册-安卓端.md §5.2）：推送只是"提醒你去看看"，不是投递保证。
 * 消息没进库就发通知，用户点开会看到一条不存在的话 —— 那是最伤信任的 bug。
 *
 * ★ 服务端判定，三道人闸：
 *   1. 未成年人一律不发：loadLimits().is_minors ⇒ 直接 skipped（且 proactive_per_day
 *      在 limits.ts 里已被夹成 0，这里是双保险）
 *   2. 频率按档位 proactive_per_day，用**当天已 sent 数**现算，不信排期方的声明
 *   3. 文案过 moderation（scope='proactive'），命中 block 就不发
 *
 * ★ 话术红线（D1 定案 + 验收 V6-9）：不施压、不制造失去感。
 *   禁用词表见 FORBIDDEN_PHRASES —— "再不回来 TA 就忘记你""没有你我怎么办"
 *   这类句子模型很爱写，必须在服务端拦掉，而不是靠提示词祈祷。
 */
import { admin, brief, json, ok, preflight, requireCron, safe } from '../_shared/http.ts';
import { builtinProfile, createProvider, mergeUsage, type Usage } from '../_shared/providers/index.ts';
import { EGRESS, REDIRECT_POLICY } from '../_shared/ssrf.ts';
import { bumpHits, inspect } from '../_shared/moderation.ts';
import { loadLimits } from '../_shared/limits.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const BATCH = 20;               // 一次运行最多处理多少条到期任务
const MAX_ATTEMPTS = 3;
const STALE_RUNNING_MS = 10 * 60_000;

/** 生成出来的关怀语上限：短促自然，长文说明模型在自我发挥 */
const CARE_MAX_TOKENS = 120;

/**
 * 施压话术黑名单。命中即弃用这条生成结果，退到模板。
 * 只列模式、不列完整句子：模型会换着法子说同一件事。
 */
const FORBIDDEN_PHRASES = [
  /忘记(你|我)/,
  /失去\s*(ta|他|她|TA)/i,
  /不(回来|理我|出现).{0,8}(就|便|会).{0,10}(消失|不见|忘记|没了)/,
  /没有你.{0,8}(活不了|不行|怎么办|撑不住)/,
  /怎么(才|会).{0,6}(回来|理我|上线)/,
  /(好久|多久)(没见|没理|不见).{0,10}(是不是不想|是不是忘了)/,
  /我会(一直)?等(到|下去)?.{0,6}(你答应|你必须)/,
  /亏欠|对不起.{0,6}我等|只有我(在|会)/,
];

function isPressuring(text: string): boolean {
  return FORBIDDEN_PHRASES.some((re) => re.test(text));
}

interface CareJob {
  id: number;
  user_id: string;
  character_id: string;
  session_id: string | null;
  kind: string;
  attempts: number;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return json(405, { error: 'METHOD_NOT_ALLOWED' });
  if (!requireCron(req)) return json(403, { error: 'FORBIDDEN' });

  const db = admin() as unknown as SupabaseClient;
  const stats = { scheduled: 0, claimed: 0, sent: 0, skipped: 0, failed: 0, pushed: 0 };

  // 1. 排期（SQL 侧已按档位与星期节流；真正的发送量在第 3 步服务端复核）
  try {
    const { data, error } = await db.rpc('schedule_care', { p_day: today() });
    if (error) console.warn('[care] schedule_care failed', safe(error.message));
    else stats.scheduled = Number(data ?? 0);
  } catch (e) {
    console.warn('[care] schedule_care threw', safe(e));
  }

  await reclaimStale(db);

  // 2. 领取到期任务
  const jobs = await claimDue(db);
  stats.claimed = jobs.length;
  if (!jobs.length) return ok({ ok: true, ...stats });

  let model;
  try {
    model = builtinProfile();
  } catch (e) {
    console.warn('[care] 内置模型未配置，本轮不生成', safe(e));
    for (const j of jobs) await release(db, j, 'model_not_configured');
    return ok({ ok: false, reason: 'MODEL_NOT_CONFIGURED', ...stats });
  }

  // 3. 逐条处理
  for (const job of jobs) {
    try {
      const r = await handleJob(db, model, job);
      if (r.skipped) stats.skipped++;
      else { stats.sent++; stats.pushed += r.pushed; }
    } catch (e) {
      stats.failed++;
      await fail(db, job, e);
      console.warn('[care] job failed', job.id, safe(e));
    }
  }

  return ok({ ok: true, ...stats });
});

// ─── 单条任务 ────────────────────────────────────────────
interface JobOutcome { skipped: boolean; pushed: number }

async function handleJob(db: SupabaseClient, profile: ReturnType<typeof builtinProfile>, job: CareJob): Promise<JobOutcome> {
  const { limits, error: limErr } = await loadLimits(db, job.user_id);
  if (limErr) { await fail(db, job, new Error(limErr)); return { skipped: true, pushed: 0 }; }

  // 闸 1：未成年人一律不发（27 号专篇 §2.1）
  if (limits.is_minors) { await skip(db, job, 'minors_protected'); return { skipped: true, pushed: 0 }; }

  // 闸 2：频率按档位现算，只看今天已经发出去几条
  if (limits.proactive_per_day <= 0) { await skip(db, job, 'tier_no_proactive'); return { skipped: true, pushed: 0 }; }
  if (await alreadySentToday(db, job.user_id) >= limits.proactive_per_day) {
    await skip(db, job, 'daily_limit');
    return { skipped: true, pushed: 0 };
  }

  const ctx = await loadContext(db, job);
  if (!ctx) { await skip(db, job, 'no_context'); return { skipped: true, pushed: 0 }; }

  // 生成 → 校验 → 必要时重试一次 → 仍不合格就用模板
  let text = await generateCare(db, profile, ctx);
  if (!text || isPressuring(text)) text = await generateCare(db, profile, ctx, true);
  if (!text || isPressuring(text)) text = fallbackText(ctx);
  text = clip(text, 200);

  // 闸 3：内容规则（proactive scope）。命中 block 连模板都不发。
  const verdict = await inspect(db, text, 'proactive');
  if (verdict.ruleIds.length) await bumpHits(db, verdict.ruleIds);
  if (!verdict.clean && verdict.action === 'block') {
    await skip(db, job, 'content_blocked');
    return { skipped: true, pushed: 0 };
  }

  // ★ 先落库。role 用 assistant（列表页要显示在气泡位），origin 标出这是它主动发的
  const { data: msg, error: msgErr } = await db.from('messages').insert({
    session_id: ctx.sessionId,
    user_id: job.user_id,
    role: 'assistant',
    character_id: job.character_id,
    content: text,
    origin: 'proactive',
  }).select('id').single();
  if (msgErr || !msg) {
    await fail(db, job, new Error('message_insert'));
    return { skipped: true, pushed: 0 };
  }

  await db.from('proactive_jobs')
    .update({ status: 'sent', message_id: msg.id, last_error: null, updated_at: new Date().toISOString() })
    .eq('id', job.id);

  // 再推送。失败绝不影响上面已经落库的消息，也不重投。
  const pushed = await tryPush(job, msg.id);
  return { skipped: false, pushed };
}

/**
 * 推送走 push 函数的 send 动作。
 * 这里刻意**不回读响应、不重试、不抛错**：
 * 消息已经在库里，客户端打开时用 since 补发就能看见（架构 §5.2）。
 */
async function tryPush(job: CareJob, messageId: string): Promise<number> {
  const url = Deno.env.get('SUPABASE_URL');
  const secret = Deno.env.get('CRON_SECRET') ?? '';
  const anon = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !anon) return 0;
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/functions/v1/push`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${anon}`,
        ...(secret ? { 'x-cron-secret': secret } : {}),
      },
      body: JSON.stringify({
        action: 'send', user_id: job.user_id, kind: 'care',
        character_id: job.character_id, message_id: messageId,
      }),
      redirect: REDIRECT_POLICY,
      signal: timeout(EGRESS.connectTimeoutMs),
    });
    return res.ok ? 1 : 0;
  } catch {
    return 0;
  }
}

// ─── 生成 ────────────────────────────────────────────────
interface CareContext {
  sessionId: string;
  name: string;
  nickname: string;
  stage: string;
  lastUserAt: string | null;
  memoryHint: string;
}

const CARE_SYSTEM = [
  '你要主动给一个人发一条消息。规则：',
  '· 一句到两句，不超过 60 字，口语，像想起对方了随手发的一条。',
  '· 只表达"想起"和"关心"，可以问一句他在做什么。',
  '· 绝不施压：不许提对方多久没来、不许说会忘记/失去/等你、不许用反问制造愧疚。',
  '· 不许提到你是 AI、不许解释这条消息的由来、不要加引号。',
  '· 只输出这一句话本身，不要任何前后缀。',
].join('\n');

async function generateCare(
  db: SupabaseClient, profile: ReturnType<typeof builtinProfile>,
  ctx: CareContext, strict = false,
): Promise<string> {
  const provider = createProvider(profile);
  const http = provider.buildHttp({
    staticPrefix: `${CARE_SYSTEM}\n${strict ? '\n【上一次产出被判定为施压话术而弃用。这次只许写一句中性的想念，不许出现任何"你不来会怎样"的含义。】' : ''}`,
    dynamic: [{
      role: 'user',
      content: [
        `对方：${ctx.nickname || '朋友'}`,
        `你的角色：${ctx.name}`,
        `关系：${stageLabel(ctx.stage)}`,
        ctx.memoryHint ? `记得的事：${ctx.memoryHint}` : '',
        ctx.lastUserAt ? `上次聊过：${humanGap(ctx.lastUserAt)}` : '',
        '现在写一条你想发给对方的话。',
      ].filter(Boolean).join('\n'),
    }],
    model: profile.model,
    maxTokens: CARE_MAX_TOKENS,
    temperature: 0.9,
    enableProviderCache: false,
  });

  const usage: Usage[] = [];
  let out = '';
  const res = await fetch(http.url, {
    method: 'POST', headers: http.headers, body: JSON.stringify(http.body),
    redirect: REDIRECT_POLICY, signal: timeout(EGRESS.connectTimeoutMs + EGRESS.firstByteTimeoutMs),
  });
  if (!res.ok || !res.body) throw new Error(`care upstream ${res.status ?? 'no-body'}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!frame.trim()) continue;
      for (const ev of provider.parseFrame(frame)) {
        if (ev.type === 'delta') out += ev.text;
        else if (ev.type === 'usage') usage.push(ev.usage);
      }
    }
  }
  void mergeUsage(usage);   // 成本统计口径与 chat 一致，但关怀由平台承担、不扣用户额度

  return out.replace(/^["'“”\s]+|["'“”\s]+$/g, '').trim();
}

/** 模型不可用/产出不合格时的兜底：不含任何时间压力，只有一句普通的惦记 */
function fallbackText(ctx: CareContext): string {
  const who = ctx.nickname ? `${ctx.nickname}，` : '';
  const pool = [
    `${who}今天过得怎么样？`,
    `突然想到你，忙不忙？`,
    `${who}记得喝点水，别一直盯着屏幕。`,
    `没什么事，就是想跟你说说话。`,
  ];
  // 用任务主键做种子取模：同一任务重试拿到同一条，避免重复投递时文案漂移
  return pool[Math.abs(ctx.sessionId.length + ctx.name.length) % pool.length];
}

function stageLabel(stage: string): string {
  return ({
    stranger: '刚认识，客气一点', acquainted: '熟悉了', close: '关系很近',
    ambiguous: '有点暧昧', established: '已经很确定',
  } as Record<string, string>)[stage] ?? '刚认识，客气一点';
}

function humanGap(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '最近';
  const days = Math.floor(ms / 86_400_000);
  if (days >= 3) return '有几天了';       // ★ 故意模糊：精确天数会诱导模型写"你三天没来了"
  if (days >= 1) return '昨天聊过';
  const hours = Math.floor(ms / 3_600_000);
  return hours >= 1 ? `${hours} 小时前聊过` : '刚刚聊过';
}

// ─── 上下文 ──────────────────────────────────────────────
async function loadContext(db: SupabaseClient, job: CareJob): Promise<CareContext | null> {
  const { data: ch } = await db.from('characters').select('id,name').eq('id', job.character_id).maybeSingle();
  if (!ch) return null;

  let sessionId = job.session_id;
  if (!sessionId) {
    const { data: m } = await db.from('session_members').select('session_id')
      .eq('character_id', job.character_id).limit(1).maybeSingle();
    sessionId = m?.session_id ?? null;
  }
  if (!sessionId) return null;

  const { data: sess } = await db.from('sessions').select('id,user_id,archived_at')
    .eq('id', sessionId).eq('user_id', job.user_id).maybeSingle();
  if (!sess || sess.archived_at) return null;

  const [{ data: prof }, { data: stage }, { data: lastMsg }] = await Promise.all([
    db.from('profiles').select('nickname').eq('id', job.user_id).maybeSingle(),
    db.from('relationship_stage').select('stage').eq('session_id', sessionId).eq('character_id', job.character_id).maybeSingle(),
    db.from('messages').select('created_at').eq('session_id', sessionId).eq('role', 'user')
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);

  return {
    sessionId,
    name: String(ch.name ?? ''),
    nickname: String(prof?.nickname ?? ''),
    stage: String(stage?.stage ?? 'stranger'),
    lastUserAt: lastMsg?.created_at ?? null,
    memoryHint: await pickMemoryHint(db, job),
  };
}

/** 只挑一条最相关的记忆当引子；召回失败不影响发送 */
async function pickMemoryHint(db: SupabaseClient, job: CareJob): Promise<string> {
  try {
    const { data } = await db.from('memories').select('text')
      .eq('user_id', job.user_id).eq('character_id', job.character_id)
      .is('invalidated_at', null)
      .order('salience', { ascending: false })
      .limit(3);
    const texts = (data ?? []).map((r: any) => String(r.text ?? '')).filter(Boolean);
    return texts.length ? texts[0].slice(0, 60) : '';
  } catch {
    return '';
  }
}

// ─── 队列操作 ────────────────────────────────────────────
async function claimDue(db: SupabaseClient): Promise<CareJob[]> {
  const { data: due } = await db.from('proactive_jobs')
    .select('id,user_id,character_id,session_id,kind,attempts')
    .eq('status', 'pending').lte('due_at', new Date().toISOString())
    .lt('attempts', MAX_ATTEMPTS)
    .order('due_at', { ascending: true }).limit(BATCH);

  const claimed: CareJob[] = [];
  for (const j of due ?? []) {
    const { data: won } = await db.from('proactive_jobs')
      .update({ status: 'running', updated_at: new Date().toISOString() })
      .eq('id', j.id).eq('status', 'pending').select('id').maybeSingle();
    if (won) claimed.push(j as CareJob);
  }
  return claimed;
}

async function reclaimStale(db: SupabaseClient) {
  const cutoff = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
  const { error } = await db.from('proactive_jobs')
    .update({ status: 'pending', updated_at: new Date().toISOString() })
    .eq('status', 'running').lt('updated_at', cutoff);
  if (error) console.warn('[care] reclaim failed', safe(error.message));
}

/** 今天的已发送数（含正在处理的这条之前的）。★ 以库为准，不看 payload 里的 tier。 */
async function alreadySentToday(db: SupabaseClient, userId: string): Promise<number> {
  const { count } = await db.from('proactive_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId).eq('status', 'sent')
    .gte('updated_at', dayStartIso());
  return count ?? 0;
}

async function skip(db: SupabaseClient, job: CareJob, reason: string) {
  await db.from('proactive_jobs').update({
    status: 'skipped', last_error: brief(reason, 60), updated_at: new Date().toISOString(),
  }).eq('id', job.id);
}

async function fail(db: SupabaseClient, job: CareJob, err: unknown) {
  const attempts = (job.attempts ?? 0) + 1;
  await db.from('proactive_jobs').update({
    status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
    attempts,
    last_error: brief(err, 200),
    updated_at: new Date().toISOString(),
  }).eq('id', job.id);
}

/** 生成了但本轮不做（比如模型没配）：放回 pending，due_at 不动，下一轮还会捞起来 */
async function release(db: SupabaseClient, job: CareJob, reason: string) {
  await db.from('proactive_jobs').update({
    status: 'pending', last_error: brief(reason, 60), updated_at: new Date().toISOString(),
  }).eq('id', job.id);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function dayStartIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function clip(s: string, max: number): string {
  return String(s ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, max);
}

function timeout(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}
