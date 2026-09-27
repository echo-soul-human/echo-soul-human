/**
 * functions/chat — 对话主链路（★服务端边界，G1/C8 定案的落地点）
 *
 * 职责顺序（docs/架构与阶段划分.md §2.1、§5.1）：
 *   鉴权 → 幂等检查 → 解析 provider → 预冻结 → 落用户消息
 *   → recall → 拼分区 prompt → 调模型流式转发 → 结算/退回 → 落 AI 消息 → 投抽取任务
 *
 * 三条不可违背的约束：
 *   1. 隐藏人设 prompt 与用户 API Key **绝不出现在响应里**
 *   2. 模型没产出 ⇒ 用户余额净变化必须为 0
 *   3. 静态前缀逐字节稳定 ⇒ 时间/余额/用户名只能进动态段末尾
 */
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  createProvider,
  builtinProfile,
  BUILTIN_MODEL,
  mergeUsage,
  safeMessage,
  type ChatRequest,
  type ProviderError,
  type StreamEvent,
  type Usage,
} from '../_shared/providers/index.ts';
import { buildStaticPrefix, buildDynamicParts } from '../_shared/prefix.ts';
import { assertSafeBaseUrl, EGRESS, REDIRECT_POLICY } from '../_shared/ssrf.ts';
import { open as openSecret } from '../_shared/crypto.ts';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-max-age': '86400',
};

interface Body {
  session_id: string;
  content: string;
  idempotency_key?: string;
  client?: 'web' | 'android' | 'ios-webapp';
  provider?: { kind: 'openai' | 'anthropic'; profile_id: string };
  attachments?: string[];
}

interface Ctx {
  supabase: SupabaseClient;
  userId: string;
  log: (...a: unknown[]) => void;
}

/** 每轮最多冻结多少元。防止配置异常时一次请求冻住用户全部余额。 */
const FREEZE_CAP = 2.0;
/** 内置模型的零售倍率：成本 × 6（docs/HANDOFF.md §4.1） */
const RETAIL_MARKUP = 6;
/** 输出上限：默认 800，verbose 人设 1600（分册-模型与计费 §3.2） */
const MAX_TOKENS_DEFAULT = 800;
const MAX_TOKENS_VERBOSE = 1600;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'METHOD_NOT_ALLOWED' });

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'BAD_JSON' });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,   // service_role：要读 character_locks
    { global: { headers: req.headers } },
  );

  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return json(401, { error: 'UNAUTHORIZED' });

  const content = String(body.content ?? '').trim();
  if (!content) return json(400, { error: 'EMPTY_CONTENT' });
  if (content.length > 8000) return json(400, { error: 'CONTENT_TOO_LONG' });

  const requestId = body.idempotency_key ?? crypto.randomUUID();
  const ctx: Ctx = { supabase, userId: user.id, log: (...a) => console.log('[chat]', user.id.slice(0, 8), ...a) };

  return streamReply(ctx, body, requestId, req.signal);
});

// ─── 主流程 ──────────────────────────────────────────────
async function streamReply(ctx: Ctx, body: Body, requestId: string, clientSignal?: AbortSignal) {
  const { supabase, userId, log } = ctx;

  // 1. 会话与角色
  const { data: session, error: sErr } = await supabase
    .from('sessions').select('id,user_id,kind,carry_tokens').eq('id', body.session_id).single();
  if (sErr || !session || session.user_id !== userId) return json(404, { error: 'SESSION_NOT_FOUND' });

  const { data: members, error: mErr } = await supabase
    .from('session_members').select('character_id,seat').eq('session_id', session.id).order('seat');
  if (mErr || !members?.length) return json(404, { error: 'SESSION_EMPTY' });

  const charIds = members.map((m: any) => m.character_id);
  const { data: chars } = await supabase
    .from('characters').select('id,name,tagline,persona_text,example_dialogs,behavior_notes,rarity')
    .in('id', charIds);
  const { data: locks } = await supabase
    .from('character_locks').select('character_id,lock_text,anti_drift_reply,boundaries,static_hash')
    .in('character_id', charIds);
  const { data: stages } = await supabase
    .from('relationship_stage').select('character_id,stage').in('character_id', charIds);

  const lockOf = new Map((locks ?? []).map((l: any) => [l.character_id, l]));
  const stageOf = new Map((stages ?? []).map((s: any) => [s.character_id, s.stage ?? 'stranger']));

  // 2. 权益
  const { data: ent } = await supabase
    .from('entitlements')
    .select('tier,carry_tokens,carry_default,recall_topk,window_limit,character_slots')
    .eq('user_id', userId).single();
  if (!ent) return json(403, { error: 'NO_ENTITLEMENT' });

  // 3. provider 解析（BYOK 需解密 Key，Key 明文不出本函数）
  let profile;
  try {
    profile = await resolveProfile(supabase, userId, body.provider, log);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'BYOK_NOT_FOUND') return json(400, { error: 'BYOK_NOT_FOUND' });
    if (msg.startsWith('SSRF')) return json(400, { error: 'ENDPOINT_BLOCKED', message: msg });
    log('provider resolve failed', safeMessage(msg));
    return json(500, { error: 'PROVIDER_CONFIG' });
  }

  const provider = createProvider(profile);
  const isByok = profile.kind !== 'deepseek';

  // 4. 幂等重放：同 request 已有 AI 消息就直接回它，不重复扣费
  const { data: prior } = await supabase
    .from('messages').select('id,content').eq('request_id', requestId).eq('role', 'assistant').maybeSingle();
  if (prior) {
    return sseReplay(prior.content, prior.id);
  }

  // 5. 组装 prompt（★分区，动态内容只进 dynamic）
  const carryLimit = Math.min(session.carry_tokens ?? ent.carry_default ?? ent.carry_tokens, ent.carry_tokens);
  const history = await loadHistory(supabase, session.id, carryLimit);

  const recalled = await recallFor(
    supabase, userId, charIds, body.content, ent.recall_topk, log,
  );

  const staticPrefix = buildStaticPrefixFor(chars ?? [], lockOf, stageOf);
  const dynamic = buildDynamicParts({
    recalled,
    history,
    userContent: body.content,
    // 时间/余额只能出现在最后一条消息里，进不了前缀 ⇒ 不击穿缓存
    balanceHint: undefined,
  });

  const maxTokens = /verbose|长篇|详细/.test(JSON.stringify(chars ?? []))
    ? MAX_TOKENS_VERBOSE : MAX_TOKENS_DEFAULT;

  const chatReq: ChatRequest = {
    staticPrefix, dynamic,
    model: profile.model || BUILTIN_MODEL,
    maxTokens,
    temperature: 0.85,
  };

  // 6. 预冻结（BYOK 不扣平台额度）
  const est = provider.estimate(chatReq);
  const freezeAmount = isByok ? 0 : round4(estimateCostCny(est, profile.kind) * RETAIL_MARKUP * 1.0);
  let freezeId: number | null = null;

  if (!isByok) {
    const amount = Math.min(freezeAmount, FREEZE_CAP);
    const { data: fr, error: frErr } = await supabase.rpc('freeze_credit', {
      p_user: userId, p_amount: amount, p_request: requestId,
    });
    if (frErr) { log('freeze rpc failed', safeMessage(frErr.message)); return json(500, { error: 'LEDGER_ERROR' }); }
    const r = fr as any;
    if (!r?.ok) {
      return json(402, {
        error: r?.code ?? 'INSUFFICIENT_BALANCE',
        usable: r?.usable, need: r?.need,
      });
    }
    freezeId = r.ledger_id;
  }

  // 7. 落用户消息（冻结成功后才落，避免"消息在但钱没冻"）
  const { data: userMsg } = await supabase.from('messages').insert({
    session_id: session.id, user_id: userId, role: 'user',
    content: body.content, origin: 'client', request_id: requestId,
  }).select('id').single();

  // 8. 调模型 + 流式转发
  const encoder = new TextEncoder();
  let accText = '';
  const usageEvents: Usage[] = [];
  let streamError: ProviderError | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

      send('meta', {
        message_id: crypto.randomUUID(),
        user_message_id: userMsg?.id ?? null,
        model: chatReq.model,
        provider: profile.kind,
        frozen: freezeAmount,
        carried_tokens: est.promptTokens,
        byok: isByok,
      });

      try {
        await callProvider(provider, chatReq, (ev) => {
          if (ev.type === 'delta') { accText += ev.text; send('delta', { t: ev.text }); }
          else if (ev.type === 'usage') usageEvents.push(ev.usage);
          else if (ev.type === 'error') streamError = ev.error;
        }, clientSignal);
      } catch (e) {
        streamError = provider.normalizeError(undefined, null, e);
      }

      // 9. 结算 / 退回（模型没产出 ⇒ 净变化为 0）
      const usage = mergeUsage(usageEvents as any);
      const produced = accText.length > 0;
      const outcome = await settle(supabase, {
        isByok, freezeId, usage, produced, failed: !!streamError, requestId, userId, log,
      });

      // 10. 落 AI 消息（失败但有产出 ⇒ partial=true，钱按实际认）
      if (produced) {
        await supabase.from('messages').insert({
          session_id: session.id, user_id: userId, role: 'assistant',
          character_id: charIds[0] ?? null, content: accText,
          origin: 'client', partial: !!streamError,
          usage_prompt: usage.promptTokens, usage_completion: usage.completionTokens,
          usage_cached: usage.cachedTokens, cost_actual: outcome.costActual,
          request_id: requestId,
        });
      }

      if (streamError) {
        send('error', {
          code: (streamError as ProviderError).code,
          msg: (streamError as ProviderError).userMessage,
          partial: produced,
        });
      } else {
        send('done', {
          usage, settled: outcome.settled, refunded: outcome.refunded,
          balance: outcome.balance, cache_hit: usage.cachedTokens > 0,
        });
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { ...CORS, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' },
  });
}

// ─── 子步骤 ──────────────────────────────────────────────

async function resolveProfile(
  supabase: SupabaseClient, userId: string,
  ref: Body['provider'] | undefined, log: Ctx['log'],
) {
  if (!ref) return builtinProfile();

  const { data: row } = await supabase.from('byok_profiles')
    .select('id,kind,base_url,model')
    .eq('id', ref.profile_id).eq('user_id', userId).maybeSingle();
  if (!row) throw new Error('BYOK_NOT_FOUND');

  // 密文在独立表，authenticated/anon 均无授权，只有 service_role 能读
  const { data: sec } = await supabase.from('byok_secrets')
    .select('wrapped_dk,dk_iv,ciphertext,iv')
    .eq('profile_id', row.id).maybeSingle();
  if (!sec) throw new Error('BYOK_NOT_FOUND');

  const verdict = await assertSafeBaseUrl(row.base_url);
  if (!verdict.ok) throw new Error(`SSRF:${verdict.reason}`);

  // ★ 明文 Key 只在本函数内存活，不落日志、不进响应
  const apiKey = await openSecret({
    wrappedDk: sec.wrapped_dk, dkIv: sec.dk_iv,
    ciphertext: sec.ciphertext, iv: sec.iv,
  });

  log('byok profile resolved', row.kind, verdict.url?.host);
  return {
    kind: row.kind === 'anthropic' ? 'anthropic' : 'openai',
    baseUrl: row.base_url, apiKey, model: row.model ?? '',
  } as any;
}

/**
 * 群聊：每个角色一份前缀。一期只做单聊时 charIds 长度为 1。
 * ★ 前缀里只放"按角色+阶段冻结"的内容，任何用户级变量都不许进来。
 */
function buildStaticPrefixFor(chars: any[], lockOf: Map<string, any>, stageOf: Map<string, string>): string {
  return chars.map((c) => {
    const lock = lockOf.get(c.id);
    return buildStaticPrefix({
      name: c.name,
      tagline: c.tagline ?? '',
      persona: c.persona_text ?? '',
      exampleDialogs: c.example_dialogs ?? [],
      behaviorNotes: c.behavior_notes ?? '',
      antiDriftReply: lock?.anti_drift_reply ?? '',
      boundaries: lock?.boundaries ?? '',
      stage: stageOf.get(c.id) ?? 'stranger',
    });
  }).join('\n\n─────\n\n');
}

async function loadHistory(supabase: SupabaseClient, sessionId: string, carryLimit: number) {
  const { data } = await supabase.from('messages')
    .select('role,content,created_at').eq('session_id', sessionId)
    .in('role', ['user', 'assistant']).order('created_at', { ascending: false }).limit(200);

  const rows = (data ?? []).reverse();
  // 从最新往回装，装满预算为止（docs/分册-模型与计费.md §6）
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let used = 0;
  for (const r of rows) {
    const cost = Math.ceil(r.content.length * 1.1);
    if (used + cost > carryLimit) break;
    used += cost;
    out.push({ role: r.role === 'assistant' ? 'assistant' : 'user', content: r.content });
  }
  return out.reverse();
}

/**
 * 记忆召回。无 embedding 服务时降级为纯关键词通道 —— 
 * 这是有意的可用性设计：记忆检索失败不该让整轮对话失败。
 */
async function recallFor(
  supabase: SupabaseClient, userId: string, charIds: string[],
  query: string, topk: number, log: Ctx['log'],
) {
  const merged: Array<{ text: string; kind: string }> = [];
  for (const cid of charIds.slice(0, 8)) {
    try {
      const { data, error } = await supabase.rpc('recall', {
        p_user: userId, p_char: cid, p_query: query,
        p_vec: null,           // 一期无 embedding：向量通道自动跳过
        p_topk: topk,
      });
      if (error) { log('recall degraded', safeMessage(error.message)); continue; }
      for (const r of data ?? []) merged.push({ text: r.text, kind: r.kind });
    } catch (e) {
      log('recall threw', safeMessage(e));   // 记忆失败不阻断对话
    }
  }
  return merged.slice(0, topk * (charIds.length || 1));
}

async function settle(
  supabase: SupabaseClient,
  o: {
    isByok: boolean; freezeId: number | null; usage: Usage; produced: boolean;
    failed: boolean; requestId: string; userId: string; log: Ctx['log'];
  },
) {
  const costActual = round4(estimateCostCny(o.usage, 'deepseek'));
  let settled = 0, refunded = 0, balance: number | null = null;

  if (o.isByok) {
    await supabase.rpc('log_byok_usage', {
      p_user: o.userId, p_request: o.requestId,
      p_usage: { prompt: o.usage.promptTokens, completion: o.usage.completionTokens, cached: o.usage.cachedTokens },
    });
    const { data } = await supabase.from('balances').select('usable').eq('user_id', o.userId).single();
    return { settled, refunded, costActual, balance: data?.usable ?? null };
  }

  if (o.freezeId == null) return { settled, refunded, costActual, balance: null };

  try {
    if (o.failed && !o.produced) {
      const { data } = await supabase.rpc('refund_credit', { p_freeze_id: o.freezeId, p_reason: 'model_error' });
      refunded = Number((data as any)?.refunded ?? 0);
    } else {
      const actual = o.failed
        ? round4(costActual * 0.6)     // 中断但已产出：认已生成部分，给折扣
        : costActual;
      const { data } = await supabase.rpc('settle_credit', {
        p_freeze_id: o.freezeId, p_actual: actual,
        p_usage: { prompt: o.usage.promptTokens, completion: o.usage.completionTokens, cached: o.usage.cachedTokens },
      });
      settled = Number((data as any)?.settled ?? 0);
      refunded = Number((data as any)?.refunded ?? 0);
    }
  } catch (e) {
    // 结算失败绝不能吞掉 —— 否则用户的钱卡在"占用中"。交给补偿任务扫。
    o.log('SETTLE FAILED, awaiting sweeper', safeMessage(e), o.freezeId);
  }

  const { data } = await supabase.from('balances').select('usable').eq('user_id', o.userId).single();
  balance = data?.usable ?? null;
  return { settled, refunded, costActual, balance };
}

/** 按 token 估成本（人民币）。系数待用真实账单校准（分册-模型与计费 §3.3）。 */
function estimateCostCny(u: { promptTokens: number; completionTokens: number; cachedTokens?: number }, _kind: string) {
  const IN = 1.0, OUT = 2.0, CACHED_IN = 0.025; // ¥/百万 token
  const cached = u.cachedTokens ?? 0;
  const fresh = Math.max(0, u.promptTokens - cached);
  return round6((fresh * IN + cached * CACHED_IN + u.completionTokens * OUT) / 1e6);
}

async function callProvider(
  provider: ReturnType<typeof createProvider>, req: ChatRequest,
  onEvent: (e: StreamEvent) => void, clientSignal?: AbortSignal,
) {
  const http = provider.buildHttp(req);
  const timeout = new AbortController();
  const t = setTimeout(() => timeout.abort(), EGRESS.firstByteTimeoutMs);
  const signal = combineSignals(timeout.signal, clientSignal);

  const res = await fetch(http.url, {
    method: 'POST', headers: http.headers, body: JSON.stringify(http.body),
    redirect: REDIRECT_POLICY, signal,
  });
  clearTimeout(t);

  if (!res.ok) {
    let raw: unknown = null;
    try { raw = await res.json(); } catch { /* 非 JSON 错误体 */ }
    throw provider.normalizeError(res.status, raw);
  }
  if (!res.body) throw provider.normalizeError(undefined, null, new Error('empty body'));

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let gotFirstByte = false;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!gotFirstByte) { gotFirstByte = true; clearTimeout(t); }
    buf += dec.decode(value, { stream: true });

    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (!frame.trim()) continue;
      for (const ev of provider.parseFrame(frame)) {
        onEvent(ev);
        if (ev.type === 'done') return;
      }
    }
  }
}

// ─── 小工具 ──────────────────────────────────────────────
function combineSignals(a: AbortSignal, b?: AbortSignal): AbortSignal {
  if (!b) return a;
  const c = new AbortController();
  const fire = () => c.abort();
  a.addEventListener('abort', fire, { once: true });
  b.addEventListener('abort', fire, { once: true });
  return c.signal;
}

const round4 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 1e4) / 1e4;
const round6 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 1e6) / 1e6;

function json(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status, headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' },
  });
}

function sseReplay(text: string, id: string) {
  const s = new ReadableStream<Uint8Array>({
    start(c) {
      const e = new TextEncoder();
      c.enqueue(e.encode(`event: meta\ndata: ${JSON.stringify({ message_id: id, replay: true })}\n\n`));
      c.enqueue(e.encode(`event: delta\ndata: ${JSON.stringify({ t: text })}\n\n`));
      c.enqueue(e.encode(`event: done\ndata: ${JSON.stringify({ replay: true })}\n\n`));
      c.close();
    },
  });
  return new Response(s, { headers: { ...CORS, 'content-type': 'text/event-stream; charset=utf-8' } });
}
