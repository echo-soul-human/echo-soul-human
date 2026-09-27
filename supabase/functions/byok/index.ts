/**
 * functions/byok — 自带 Key 的档案增删查
 *
 * 三张脸，一条铁律：**明文 Key 只在函数内存活，只回掩码**。
 *   · list   返回元数据 + key_mask（byok_profiles 表里本就没有密文）
 *   · add    assertSafeBaseUrl → seal() 信封加密 → 元数据与密文分表写
 *   · verify 发一个 max_tokens=1 的最小请求，失败只回**中文分类**
 *   · delete 两张表真删（byok_secrets 有 on delete cascade，但仍显式删两遍兜底）
 *
 * 为什么 verify 必须翻译错误（docs/legal/03-BYOK第三方服务接入条款.md、
 * docs/分册-模型与计费.md §4.3）：上游返回的是英文原文，里面可能带
 * 用户自己的 model 名、endpoint、甚至 echo 回来的请求头。把这些直接甩给用户
 * 既看不懂也不安全。用户只需要知道"下一步该改哪个字段"。
 *
 * ★ 档位判定在服务端：can_byok=false（含未成年人）一律拒新增。
 */
import { body, json, ok, preflight, requireUser, safe } from '../_shared/http.ts';
import { assertSafeBaseUrl, EGRESS, REDIRECT_POLICY } from '../_shared/ssrf.ts';
import { mask, open as openSecret, seal } from '../_shared/crypto.ts';
import { loadLimits } from '../_shared/limits.ts';
import { createProvider, type ResolvedProfile } from '../_shared/providers/index.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

interface ReqBody {
  action?: string;
  profile_id?: string;
  kind?: string;
  label?: string;
  base_url?: string;
  model?: string;
  api_key?: string;
  extra_body?: Record<string, unknown>;
}

const KINDS = ['openai', 'anthropic'] as const;
const MAX_PROFILES = 10;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return json(405, { error: 'METHOD_NOT_ALLOWED' });

  const b = await body<ReqBody>(req);
  if (!b) return json(400, { error: 'BAD_JSON' });

  const authed = await requireUser(req);
  if (!authed) return json(401, { error: 'UNAUTHORIZED' });

  // db 用于读写 byok_secrets —— 那张表对 authenticated/anon 零授权，只有 service_role 能碰
  const db = authed.db as unknown as SupabaseClient;
  const userId = authed.user.id;
  const action = String(b.action ?? '').trim().toLowerCase();

  switch (action) {
    case 'list':   return handleList(db, userId);
    case 'add':    return handleAdd(db, userId, b);
    case 'verify': return handleVerify(db, userId, b);
    case 'delete': return handleDelete(db, userId, b);
    default:       return json(400, { error: 'UNKNOWN_ACTION' });
  }
});

// ─── list ────────────────────────────────────────────────
async function handleList(db: SupabaseClient, userId: string) {
  const { data, error } = await db.from('byok_profiles')
    .select('id,kind,label,base_url,model,key_mask,enabled,last_used_at,created_at')
    .eq('user_id', userId).order('created_at');
  if (error) return json(500, { error: 'LIST_FAILED' });
  return ok({ profiles: data ?? [] });
}

// ─── add ─────────────────────────────────────────────────
async function handleAdd(db: SupabaseClient, userId: string, b: ReqBody) {
  const { limits, error: limErr } = await loadLimits(db, userId);
  if (limErr) return json(500, { error: 'LEDGER_UNAVAILABLE' });
  if (!limits.can_byok) return json(403, { error: 'BYOK_NOT_AVAILABLE' });

  const kind = (KINDS as readonly string[]).includes(String(b.kind)) ? b.kind as typeof KINDS[number] : null;
  if (!kind) return json(400, { error: 'BAD_KIND' });

  const apiKey = String(b.api_key ?? '').trim();
  if (!apiKey || apiKey.length < 8 || apiKey.length > 512) return json(400, { error: 'BAD_KEY' });

  const baseUrl = String(b.base_url ?? '').trim();
  const verdict = await assertSafeBaseUrl(baseUrl);
  if (!verdict.ok) return json(400, { error: 'ENDPOINT_BLOCKED', message: verdict.reason });

  const { count } = await db.from('byok_profiles')
    .select('id', { count: 'exact', head: true }).eq('user_id', userId);
  if ((count ?? 0) >= MAX_PROFILES) return json(403, { error: 'PROFILE_LIMIT' });

  let sealed;
  try {
    sealed = await seal(apiKey);
  } catch (e) {
    console.error('[byok] seal failed', safe(e));
    return json(500, { error: 'ENCRYPT_FAILED' });
  }

  const row = {
    user_id: userId,
    kind,
    label: String(b.label ?? '').trim().slice(0, 40),
    // 存校验过的形态，别把用户手打的多余斜杠带进后续拼接
    base_url: normalizeBase(verdict.url!),
    model: String(b.model ?? '').trim().slice(0, 120),
    key_mask: mask(apiKey),
    extra_body: sanitizeExtraBody(b.extra_body),
    enabled: true,
  };

  const { data: profile, error } = await db.from('byok_profiles').insert(row).select('id').single();
  if (error || !profile) {
    console.error('[byok] insert profile failed', safe(error?.message));
    return json(500, { error: 'PROFILE_INSERT_FAILED' });
  }

  const { error: secErr } = await db.from('byok_secrets').insert({
    profile_id: profile.id,
    user_id: userId,
    wrapped_dk: sealed.wrappedDk,
    dk_iv: sealed.dkIv,
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
  });
  if (secErr) {
    // 不留"有元数据没密文"的半条档案：那样它会永远验证不过去
    await db.from('byok_profiles').delete().eq('id', profile.id).eq('user_id', userId);
    console.error('[byok] insert secret failed', safe(secErr.message));
    return json(500, { error: 'SECRET_INSERT_FAILED' });
  }

  // ★ 响应里只有掩码。绝不含明文 Key、绝不含密文四元组。
  return ok({ ok: true, profile_id: profile.id, key_mask: row.key_mask });
}

// ─── verify ──────────────────────────────────────────────
async function handleVerify(db: SupabaseClient, userId: string, b: ReqBody) {
  const id = String(b.profile_id ?? '').trim();
  if (!isUuid(id)) return json(400, { error: 'BAD_PROFILE_ID' });

  const loaded = await loadProfile(db, userId, id);
  if (!loaded) return json(404, { error: 'BYOK_NOT_FOUND' });

  const probe = await runProbe(loaded.profile);
  if (probe.ok) {
    await db.from('byok_profiles').update({ last_used_at: new Date().toISOString() }).eq('id', id);
    return ok({ ok: true, verified: true, model: loaded.profile.model });
  }

  return ok({
    ok: false,
    verified: false,
    // 只给分类与中文说明；detail 是本地生成的分类码，不是上游原文
    reason: probe.reason,
    message: MESSAGE[probe.reason],
    fix_hint: HINT[probe.reason],
  });
}

type VerifyReason =
  | 'key_rejected'      // Key 不对
  | 'model_not_found'   // 模型名不存在
  | 'bad_endpoint'      // 地址不对
  | 'network'           // 网不通
  | 'rate_limited'
  | 'upstream_error'
  | 'blocked_content'
  | 'unknown';

const MESSAGE: Record<VerifyReason, string> = {
  key_rejected: '这把 Key 被对方拒绝了，检查一下是不是填错或者已经作废。',
  model_not_found: '连上了，但这个模型名对方不认。换成控制台里能看到的那个。',
  bad_endpoint: '地址不太对：要么格式有问题，要么那个地址上没有对话接口。',
  network: '连不上这个地址。检查网络，或者换一个能公开访问的端点。',
  rate_limited: '对方说这会儿请求太密了。过一会儿再试一次。',
  upstream_error: '对方服务现在不太稳定，稍后再试。',
  blocked_content: '这声招呼被对方的内容策略挡了，说明 Key 和地址是对的。',
  unknown: '没能验证成功，原因不好归到某一种上。可以再试一次。',
};

const HINT: Record<VerifyReason, string> = {
  key_rejected: '重新复制一次 Key（注意别漏开头结尾），或换一把。',
  model_not_found: '模型名区分大小写，也别带空格。',
  bad_endpoint: '一般填到 /v1 这一层就够了，不要带 /chat/completions。',
  network: '确认地址是可公网访问的 https。',
  rate_limited: '不用改设置，等一会儿再来。',
  upstream_error: '不用改设置，等一会儿再来。',
  blocked_content: '可以开始用了。',
  unknown: '再试一次；一直不行的话换一把 Key。',
};

/**
 * 最小请求：max_tokens=1。
 * ★ 刻意**不**带人设前缀：连通性测试没必要把整段平台锁发给用户的第三方端点，
 *   那既多烧用户自己的 token，也没必要（前缀正确性由 chat 链路负责）。
 *   内容只是一句招呼 ⇒ 不会把任何真实对话数据送出去。
 */
async function runProbe(profile: ResolvedProfile): Promise<{ ok: true } | { ok: false; reason: VerifyReason }> {
  let http: { url: string; headers: Record<string, string>; body: unknown };
  try {
    const provider = createProvider(profile);
    http = provider.buildHttp({
      staticPrefix: '这是一次连接测试，请只回复一个字符。',
      dynamic: [{ role: 'user', content: 'ping' }],
      model: profile.model,
      maxTokens: 1,
      temperature: 0,
      // 连通性探测不该在 BYOK 端写缓存：Anthropic 的 cache_control 写入要按 1.25× 付费
      enableProviderCache: false,
    });
  } catch (e) {
    console.error('[byok] probe build failed', safe(e));
    return { ok: false, reason: 'bad_endpoint' };
  }

  let res: Response;
  try {
    res = await fetch(http.url, {
      method: 'POST',
      headers: http.headers,
      body: JSON.stringify(http.body),
      redirect: REDIRECT_POLICY,
      signal: timeout(EGRESS.connectTimeoutMs + EGRESS.firstByteTimeoutMs),
    });
  } catch (e) {
    // AbortError / TimeoutError / DNS 全算"网不通"；原始异常文本可能含 URL，不外传
    console.warn('[byok] probe network failure', safe(e));
    return { ok: false, reason: 'network' };
  }

  if (res.ok) {
    // 200 但内容被过滤：Key 与地址都是通的，只是上游拦了这一句
    const maybeFiltered = await lookedFiltered(res);
    return maybeFiltered ? { ok: false, reason: 'blocked_content' } : { ok: true };
  }

  const raw = await readErrorShape(res);
  return { ok: false, reason: classifyStatus(res.status, raw) };
}

/** 状态码 + 上游 error 字段 → 四类可懂原因。绝不把原文透给用户。 */
function classifyStatus(status: number, raw: { message?: string; code?: string; type?: string }): VerifyReason {
  const blob = `${raw.type ?? ''} ${raw.code ?? ''} ${raw.message ?? ''}`.toLowerCase();

  if (/incorrect api key|invalid api key|invalid_api_key|authentication|unauthorized|api key/.test(blob)) return 'key_rejected';
  if (/model.*(not.*(found|exist))|does not exist|unknown model|no such model/.test(blob)) return 'model_not_found';
  if (/url|endpoint|base url|unsupported.*protocol|invalid.*host/.test(blob)) return 'bad_endpoint';
  if (/rate.?limit|too many requests|quota.*(exceeded|reached)|overloaded/.test(blob)) return 'rate_limited';
  if (/content.?policy|content_filter|flagged|safety|prohibited/.test(blob)) return 'blocked_content';

  if (status === 401 || status === 403) return 'key_rejected';
  if (status === 404) return 'model_not_found';
  if (status === 400 || status === 422) return 'bad_endpoint';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream_error';
  return 'unknown';
}

/** 只取 error.{type,code,message} 三个字符串字段，且立刻脱敏截断 */
async function readErrorShape(res: Response): Promise<{ message?: string; code?: string; type?: string }> {
  try {
    const j: any = await res.json();
    const e = j?.error ?? j ?? {};
    return {
      message: typeof e?.message === 'string' ? safe(e.message) : undefined,
      code: typeof e?.code === 'string' ? safe(e.code) : undefined,
      type: typeof e?.type === 'string' ? safe(e.type) : undefined,
    };
  } catch {
    return {};
  }
}

async function lookedFiltered(res: Response): Promise<boolean> {
  try {
    const j: any = await res.clone().json();
    const finish = j?.choices?.[0]?.finish_reason ?? '';
    return typeof finish === 'string' && /content_filter|refusal/i.test(finish);
  } catch {
    return false;
  }
}

// ─── delete ──────────────────────────────────────────────
async function handleDelete(db: SupabaseClient, userId: string, b: ReqBody) {
  const id = String(b.profile_id ?? '').trim();
  if (!isUuid(id)) return json(400, { error: 'BAD_PROFILE_ID' });

  // 先删密文再删元数据：cascade 依赖库侧约束，这里不赌它一定在
  const { error: secErr } = await db.from('byok_secrets').delete().eq('profile_id', id).eq('user_id', userId);
  const { error, count } = await db.from('byok_profiles').delete({ count: 'exact' })
    .eq('id', id).eq('user_id', userId);
  if (error) {
    console.error('[byok] delete failed', safe(error.message));
    return json(500, { error: 'DELETE_FAILED' });
  }
  if (!count) return json(404, { error: 'BYOK_NOT_FOUND' });
  if (secErr) console.warn('[byok] secret delete reported error', safe(secErr.message));
  return ok({ ok: true, deleted: true });
}

// ─── 共用 ────────────────────────────────────────────────
/**
 * 取出档案并解密 Key。★ 返回的 apiKey 明文只在调用栈里存活：
 * 不落日志、不进响应、不出本模块。
 */
async function loadProfile(
  db: SupabaseClient, userId: string, profileId: string,
): Promise<{ profile: ResolvedProfile } | null> {
  const { data } = await db.from('byok_profiles')
    .select('id,kind,base_url,model,extra_body').eq('id', profileId).eq('user_id', userId).maybeSingle();
  if (!data) return null;

  // byok_secrets 对用户侧零授权 ⇒ 必须走 admin()（db 就是 service_role 客户端）
  const { data: sec } = await db.from('byok_secrets')
    .select('wrapped_dk,dk_iv,ciphertext,iv').eq('profile_id', data.id).maybeSingle();
  if (!sec) return null;

  const guard = await assertSafeBaseUrl(data.base_url);
  if (!guard.ok) return null;

  let apiKey: string;
  try {
    apiKey = await openSecret({ wrappedDk: sec.wrapped_dk, dkIv: sec.dk_iv, ciphertext: sec.ciphertext, iv: sec.iv });
  } catch (e) {
    console.error('[byok] open secret failed', safe(e));
    return null;
  }

  return {
    profile: {
      kind: data.kind === 'anthropic' ? 'anthropic' : 'openai',
      baseUrl: data.base_url,
      apiKey,
      model: data.model ?? '',
      extraBody: (data.extra_body ?? {}) as Record<string, unknown>,
    } as ResolvedProfile,
  };
}

/** 高级面板透传字段：白名单键、值限长，杜绝把 authorization 之类塞进请求体 */
const EXTRA_BODY_ALLOW = new Set([
  'top_p', 'presence_penalty', 'frequency_penalty', 'stop', 'response_format',
  'thinking', 'reasoning_effort', 'service_tier', 'user',
]);

function sanitizeExtraBody(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!EXTRA_BODY_ALLOW.has(k)) continue;
    const s = (() => { try { return JSON.stringify(val); } catch { return ''; } })();
    if (s.length > 512) continue;
    out[k] = val;
  }
  return out;
}

/** Anthropic 的 provider 会自己拼 /v1/messages，OpenAI 兼容的拼 /chat/completions */
function normalizeBase(url: URL): string {
  return url.toString().replace(/\/+$/, '');
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
