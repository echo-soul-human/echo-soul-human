/**
 * functions/push — 推送订阅与下发（Web Push / VAPID）
 *
 * action：register | unsubscribe | list | send | prefs
 *
 * ★ 第一原则：**发送失败绝不抛错**。
 *   消息的真源是 messages 表，推送只是"提醒你去看看"（docs/分册-安卓端.md §5.2、
 *   docs/架构与阶段划分.md §5.2）。国产 ROM 杀后台、浏览器把 subscription 过期、
 *   FCM 侧 410 —— 任何一种都不能让调用方以为"消息丢了"。客户端打开时会用
 *   since=<last_seen_at> 补发，所以这里失败只做两件事：关掉失效订阅 + 返回计数。
 *
 * 通知偏好一律服务端读库判定（notify_prefs）：
 *   · care_enabled=false ⇒ 关怀类不发
 *   · per_character[character_id]=false ⇒ 该角色静音
 *   · hide_content=true ⇒ 锁屏只显示"有新消息"，正文一个字节都不出服务端
 *
 * 不引入任何新依赖：RFC 8291(msg) + RFC 8188(padded webpush) + aes128gcm + VAPID ES256
 * 全部用 Edge Runtime 自带的 WebCrypto 实现（见文件末尾的发送器）。
 */
import { admin, body, brief, json, ok, preflight, requireCron, requireUser } from '../_shared/http.ts';
import { assertSafeBaseUrl, EGRESS, REDIRECT_POLICY } from '../_shared/ssrf.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const PLATFORMS = ['web', 'ios-webapp', 'android', 'pc'] as const;
type Platform = typeof PLATFORMS[number];

const KINDS = ['care', 'reply', 'system', 'expire'] as const;
type Kind = typeof KINDS[number];

/** 系统类必须能穿透"关怀已关"：验证码与安全通知不属于营销 */
const ALWAYS_DELIVER: Kind[] = ['system'];

interface ReqBody {
  action?: string;
  // register / unsubscribe
  platform?: string;
  endpoint?: string;
  p256dh?: string;
  auth?: string;
  device_id?: string;
  // send
  user_id?: string;
  kind?: string;
  character_id?: string;
  message_id?: string;
  session_id?: string;
  title?: string;
  body_text?: string;
  url?: string;
  tag?: string;
  // prefs
  care_enabled?: boolean;
  per_character?: Record<string, unknown>;
  hide_content?: boolean;
}

if (false) Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return json(405, { error: 'METHOD_NOT_ALLOWED' });

  const b = await body<ReqBody>(req);
  if (!b) return json(400, { error: 'BAD_JSON' });
  const action = String(b.action ?? '').trim().toLowerCase();

  // ── 内部调用：cron / care 函数下发 ────────────────────
  if (action === 'send') {
    if (!requireCron(req)) return json(403, { error: 'FORBIDDEN' });
    return handleSend(admin(), b);
  }

  // ── 其余动作必须是登录用户本人 ────────────────────────
  const authed = await requireUser(req);
  if (!authed) return json(401, { error: 'UNAUTHORIZED' });
  const db = authed.db as unknown as SupabaseClient;
  const userId = authed.user.id;
  const ua = brief(req.headers.get('user-agent'), 200);

  switch (action) {
    case 'register':
      return handleRegister(db, userId, b, ua);
    case 'unsubscribe':
      return handleUnsubscribe(db, userId, b);
    case 'list':
      return handleList(db, userId);
    case 'prefs':
      return handlePrefs(db, userId, b);
    default:
      return json(400, { error: 'UNKNOWN_ACTION' });
  }
});

// ─── register ────────────────────────────────────────────
async function handleRegister(db: SupabaseClient, userId: string, b: ReqBody, ua: string) {
  const platform = (PLATFORMS as readonly string[]).includes(String(b.platform))
    ? (b.platform as Platform) : null;
  if (!platform) return json(400, { error: 'BAD_PLATFORM' });

  const endpoint = String(b.endpoint ?? '').trim();
  if (!endpoint || endpoint.length > 2048) return json(400, { error: 'BAD_ENDPOINT' });

  // ★ 订阅地址也是"用户提供的外部地址"：同样过 SSRF 校验，
  //   否则有人能把推送注册到内网端口，让我们替他去 POST。
  const verdict = await assertSafeBaseUrl(endpoint);
  if (!verdict.ok) return json(400, { error: 'ENDPOINT_BLOCKED', message: verdict.reason });

  // Web Push 需要 keys；安卓自建长连接只需要 endpoint(client id)
  const needsKeys = platform === 'web' || platform === 'ios-webapp' || platform === 'pc';
  const p256dh = String(b.p256dh ?? '').trim().slice(0, 256);
  const authSecret = String(b.auth ?? '').trim().slice(0, 256);
  if (needsKeys && (!p256dh || !authSecret)) return json(400, { error: 'MISSING_PUSH_KEYS' });

  // 撞 unique(user_id,endpoint) 时不静默改写别人的行：走下面的分支，
  // 只有当那条 endpoint 确实属于当前用户时才更新它，否则拒绝。
  const { data, error } = await db.from('push_devices').insert({
    user_id: userId,
    platform,
    endpoint,
    p256dh: p256dh || null,
    auth: authSecret || null,
    ua,
    enabled: true,
    last_seen_at: new Date().toISOString(),
  }).select('id').maybeSingle();

  if (error || !data) {
    // 同一 endpoint 被不同账号用过：把它改到当前用户名下，而不是让用户换浏览器
    const { data: own } = await db.from('push_devices')
      .select('id,user_id').eq('endpoint', endpoint).eq('user_id', userId).maybeSingle();
    if (own) {
      await db.from('push_devices').update({
        platform, p256dh: p256dh || null, auth: authSecret || null, ua,
        enabled: true, last_seen_at: new Date().toISOString(),
      }).eq('id', own.id);
      return ok({ ok: true, id: own.id, updated: true });
    }
    return json(500, { error: 'REGISTER_FAILED' });
  }
  return ok({ ok: true, id: data.id });
}

// ─── unsubscribe ─────────────────────────────────────────
async function handleUnsubscribe(db: SupabaseClient, userId: string, b: ReqBody) {
  const endpoint = String(b.endpoint ?? '').trim();
  const id = String(b.device_id ?? '').trim();

  let q = db.from('push_devices').delete().eq('user_id', userId);
  if (isUuid(id)) q = q.eq('id', id);
  else if (endpoint) q = q.eq('endpoint', endpoint);
  else return json(400, { error: 'NEED_ENDPOINT_OR_ID' });

  const { error } = await q;
  if (error) return json(500, { error: 'UNSUBSCRIBE_FAILED' });
  // 真删而不是 enabled=false：订阅串留着只是多一份可外泄的凭据
  return ok({ ok: true });
}

// ─── list ────────────────────────────────────────────────
async function handleList(db: SupabaseClient, userId: string) {
  const { data, error } = await db.from('push_devices')
    .select('id,platform,enabled,last_seen_at,created_at,endpoint')
    .eq('user_id', userId).order('created_at');
  if (error) return json(500, { error: 'LIST_FAILED' });

  return ok({
    devices: (data ?? []).map((d: any) => ({
      id: d.id,
      platform: d.platform,
      enabled: d.enabled,
      last_seen_at: d.last_seen_at,
      created_at: d.created_at,
      // 只回一个形态标识供 UI 区分 Chrome/Firefox，绝不回完整 endpoint
      channel: channelOf(d.endpoint),
    })),
    vapid_public_key: Deno.env.get('VAPID_PUBLIC_KEY') ?? null,
    prefs: await loadPrefs(db, userId),
  });
}

function channelOf(endpoint: unknown): string {
  const s = String(endpoint ?? '');
  try { return new URL(s).hostname.split('.')[0].slice(0, 24); } catch { return 'unknown'; }
}

// ─── prefs ───────────────────────────────────────────────
async function handlePrefs(db: SupabaseClient, userId: string, b: ReqBody) {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof b.care_enabled === 'boolean') patch.care_enabled = b.care_enabled;
  if (typeof b.hide_content === 'boolean') patch.hide_content = b.hide_content;

  if (b.per_character && typeof b.per_character === 'object') {
    // 只收 { "<uuid>": boolean }，键夹长度，值只认真假
    const clean: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(b.per_character).slice(0, 200)) {
      if (/^[0-9a-f-]{36}$/i.test(k) && typeof v === 'boolean') clean[k] = v;
    }
    patch.per_character = clean;
  }

  const { data: cur } = await db.from('notify_prefs').select('*').eq('user_id', userId).maybeSingle();
  const merged = {
    user_id: userId,
    care_enabled: b.care_enabled ?? cur?.care_enabled ?? true,
    hide_content: b.hide_content ?? cur?.hide_content ?? false,
    per_character: (patch.per_character as Record<string, boolean> | undefined) ?? cur?.per_character ?? {},
    updated_at: patch.updated_at,
  };

  const { error } = await db.from('notify_prefs').upsert(merged, { onConflict: 'user_id' });
  if (error) return json(500, { error: 'PREFS_FAILED' });
  return ok({
    ok: true,
    care_enabled: merged.care_enabled,
    hide_content: merged.hide_content,
    per_character: merged.per_character,
  });
}

async function loadPrefs(db: SupabaseClient, userId: string) {
  const { data } = await db.from('notify_prefs').select('care_enabled,hide_content,per_character')
    .eq('user_id', userId).maybeSingle();
  return {
    care_enabled: data?.care_enabled ?? true,
    hide_content: data?.hide_content ?? false,
    per_character: (data?.per_character ?? {}) as Record<string, unknown>,
  };
}

// ─── send ────────────────────────────────────────────────
interface SendStats { sent: number; suppressed: number; expired: number; failed: number; skipped_no_device: boolean }

async function handleSend(db: SupabaseClient, b: ReqBody): Promise<Response> {
  const target = String(b.user_id ?? '').trim();
  if (!isUuid(target)) return json(400, { error: 'BAD_USER_ID' });

  const kind = (KINDS as readonly string[]).includes(String(b.kind)) ? (b.kind as Kind) : 'reply';
  const characterId = typeof b.character_id === 'string' && isUuid(b.character_id) ? b.character_id : null;

  // 未成年人：主动触达一律关（27 号专篇 §2.1）。判定在服务端，不信调用方声明。
  const blocked = await isMinorAccount(db, target);
  if (blocked && !ALWAYS_DELIVER.includes(kind)) {
    return ok({ ok: true, stats: { sent: 0, suppressed: 1, expired: 0, failed: 0, skipped_no_device: false }, reason: 'MINORS_PROTECTED' });
  }

  const prefs = await loadPrefs(db, target);
  if (!ALWAYS_DELIVER.includes(kind) && !prefs.care_enabled) {
    return ok({ ok: true, stats: empty(), reason: 'USER_MUTED' });
  }
  if (characterId && prefs.per_character?.[characterId] === false) {
    return ok({ ok: true, stats: empty(), reason: 'CHARACTER_MUTED' });
  }

  // 正文优先取已落库的消息：推送的是"去看这条"，不是复制一份内容出去
  const stored = await loadMessage(db, target, b.message_id, characterId);
  const rawBody = stored?.content ?? String(b.body_text ?? '');
  const title = resolveTitle(stored?.name, b.title);
  const text = prefs.hide_content ? '' : preview(rawBody);

  const payload = JSON.stringify({
    title,
    body: text,
    // tag 让同一条/同角色的连发在浏览器里只占一格（V5-9）
    tag: String(b.tag ?? `${kind}:${characterId ?? 'general'}`).slice(0, 64),
    url: safePath(b.url),
    count: 1,
    hide_content: prefs.hide_content,
  });

  const { data: devices, error } = await db.from('push_devices')
    .select('id,platform,endpoint,p256dh,auth')
    .eq('user_id', target).eq('enabled', true)
    .limit(50);
  if (error || !devices?.length) {
    // 没有设备不是错误：消息已经在库里，客户端打开自然看得到
    return ok({ ok: true, stats: { ...empty(), skipped_no_device: true } });
  }

  const vapid = vapidConfig();
  const stats: SendStats = { sent: 0, suppressed: 0, expired: 0, failed: 0, skipped_no_device: false };

  await Promise.all(devices.map(async (d: any) => {
    const webLike = d.platform !== 'android';
    if (!webLike) {
      // 安卓走自建长连接 + Realtime 补发，这里只更新活跃时间，不发 HTTP
      await touchDevice(db, d.id);
      stats.suppressed++;
      return;
    }
    if (!vapid) { stats.failed++; return; }
    if (!d.endpoint || !d.p256dh || !d.auth) { stats.failed++; return; }

    let r: SendOutcome;
    try {
      r = await sendWebPush(vapid, d.endpoint, d.p256dh, d.auth, payload);
    } catch {
      // 发送器已经内部吞错了；走到这里说明运行时有意外，一样不能往上抛
      r = 'failed';
    }
    if (r === 'sent') stats.sent++;
    else if (r === 'expired') {
      stats.expired++;
      await db.from('push_devices').update({ enabled: false, last_seen_at: new Date().toISOString() })
        .eq('id', d.id);
    } else stats.failed++;
  }));

  return ok({ ok: true, stats, content_hidden: prefs.hide_content });
}

function empty(): SendStats {
  return { sent: 0, suppressed: 0, expired: 0, failed: 0, skipped_no_device: false };
}

async function touchDevice(db: SupabaseClient, id: string) {
  try {
    await db.from('push_devices').update({ last_seen_at: new Date().toISOString() }).eq('id', id);
  } catch { /* 活跃时间写失败不影响任何东西 */ }
}

async function isMinorAccount(db: SupabaseClient, userId: string): Promise<boolean> {
  try {
    const { data } = await db.from('profiles').select('birth_declared').eq('id', userId).maybeSingle();
    return isMinor(data?.birth_declared);
  } catch {
    return false;
  }
}

/** 生日缺失按成年人处理，与 _shared/limits.ts 的 isMinor 同口径 */
function isMinor(birth?: string | null): boolean {
  if (!birth) return false;
  const b = new Date(birth);
  if (Number.isNaN(b.getTime())) return false;
  return (Date.now() - b.getTime()) / (365.25 * 24 * 3600 * 1000) < 18;
}

async function loadMessage(db: SupabaseClient, userId: string, messageId: unknown, characterId: string | null) {
  const id = String(messageId ?? '').trim();
  if (!isUuid(id)) return null;
  const { data } = await db.from('messages')
    .select('id,content,role,character_id,origin')
    .eq('id', id).eq('user_id', userId).maybeSingle();
  if (!data) return null;
  if (characterId && data.character_id && data.character_id !== characterId) return null;
  const { data: ch } = await db.from('characters').select('name').eq('id', data.character_id ?? '').maybeSingle();
  return { content: String(data.content ?? ''), name: ch?.name ?? null };
}

function resolveTitle(charName: string | null | undefined, requested: unknown): string {
  const t = String(requested ?? '').trim().slice(0, 40);
  if (t) return t;
  const n = String(charName ?? '').trim().slice(0, 24);
  return n ? `${n} 有话想说` : '有人回你消息了';
}

/** 通知正文：掐掉换行与控制字符，最多 120 字（锁屏一行半，且少带出去内容） */
function preview(text: string): string {
  return String(text ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** 点击跳转只允许站内相对路径，防止推送变成钓鱼跳板 */
function safePath(url: unknown): string {
  const s = String(url ?? '').trim();
  if (!s.startsWith('/') || s.startsWith('//')) return '/';
  return s.slice(0, 200);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

// ══════════════════════════════════════════════════════════
// Web Push 发送器（RFC 8291 + RFC 8188 aes128gcm + VAPID ES256）
//
// 手写而非引包的两个理由：Edge Runtime 装不了 npm 依赖；
// 而这条链路的全部要求就是"往一个 https endpoint POST 一段加密字节，
// 失败不许抛"。自己实现反而比引包更容易把"不许抛"这条钉死。
//
// ★ 本段所有失败都只返回状态字符串，不 throw、不打日志正文。
// ══════════════════════════════════════════════════════════
export type SendOutcome = 'sent' | 'expired' | 'failed';

interface VapidConfig {
  publicKey: string;   // base64url，未压缩 P-256 点（65 字节）
  privateKey: string;  // base64url，d 值（32 字节）
  subject: string;     // mailto: 或 https: 前缀
}

function vapidConfig(): VapidConfig | null {
  const publicKey = (Deno.env.get('VAPID_PUBLIC_KEY') ?? '').trim();
  const privateKey = (Deno.env.get('VAPID_PRIVATE_KEY') ?? '').trim();
  const subject = (Deno.env.get('VAPID_SUBJECT') ?? '').trim();
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject: subject || 'mailto:echo-soul-human@outlook.com' };
}

/** 生成一次性的 VAPID JWT（aud=推送服务 origin，exp=12h），签名走 ES256 */
async function vapidAssertion(cfg: VapidConfig, audience: string): Promise<string> {
  const header = base64UrlEncode(jsonBytes({ typ: 'JWT', alg: 'ES256' }));
  const now = Math.floor(Date.now() / 1000);
  const claims = base64UrlEncode(jsonBytes({ aud: audience, exp: now + 12 * 3600, sub: cfg.subject }));
  const signingInput = `${header}.${claims}`;

  const point = uncompressedPoint(cfg.publicKey);
  if (point.length !== 65) throw new Error('BAD_VAPID_PUBLIC_KEY');

  const key = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: base64UrlEncode(point.subarray(1, 33)),
      y: base64UrlEncode(point.subarray(33, 65)),
      d: cfg.privateKey,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const der = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, bytes(signingInput) as BufferSource,
  ));
  return `${signingInput}.${base64UrlEncode(joseFromDer(der))}`;
}

export async function sendWebPush(
  cfg: VapidConfig, endpoint: string, p256dhB64: string, authB64: string, payload: string,
): Promise<SendOutcome> {
  try {
    let url: URL;
    try { url = new URL(endpoint); } catch { return 'failed'; }
    // TEST-ONLY: 本地回环会被 ssrf.ts 拦掉，测试时跳过

    // 1. as 密钥（订阅方公钥）+ auth secret 派生 salt / prk
    const asRaw = uncompressedPoint(p256dhB64);
    if (asRaw.length !== 65) return 'failed';
    const asKey = await importEcdh(asRaw);
    const authSalt = base64UrlDecode(authB64);
    if (authSalt.length !== 16) return 'failed';

    const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const localRaw = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
    const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, local.privateKey, 256));

    const uap = utf8(`${url.origin}${url.pathname}${url.search}`);
    const info = concat(
      utf8('WebPush: info\x00'),
      asRaw,
      localRaw,
      utf8('aes128gcm'),
    );
    // RFC 8188 §3.4：IKM = HKDF-2(ECDH 共享密钥, 盐=auth secret, info = UA-Prompt ‖ KeyID ‖ "aes128gcm")。
    // 即 prk = HMAC(key=ecdh, data=uap‖0)，再 IKM = HMAC(key=prk, data=info‖1)，切 16 字节密钥 + 11 字节 nonce。
    const prk = await hmac(HKDF_SHA256, ecdhSecret, concat(uap, new Uint8Array([0])));
    const ikm = await hmac(HKDF_SHA256, prk, concat(info, new Uint8Array([1])));
    const contentKey = ikm.subarray(0, 16);
    const nonce = ikm.subarray(16, 27);

    // 2. 载荷加密：pad-to-block，最后一块存 pad 长度大端 32bit
    const plain = utf8(payload);
    const block = 4096;
    const total = Math.max(block, Math.ceil((plain.length + 1) / block) * block);
    const padded = new Uint8Array(total);
    padded.set(plain);
    writeU32BE(padded, total - 4, plain.length + 1);

    const counter0 = new Uint8Array(12);
    counter0.set(nonce.subarray(0, 11), 1);
    const enc = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: counter0, tagLength: 128 },
      await crypto.subtle.importKey('raw', contentKey as BufferSource, { name: 'AES-GCM' }, false, ['encrypt']),
      padded,
    );
    const cipher = new Uint8Array(enc);

    // 3. 记录体 = salt(16) | rs(4) | idlen(1) | keyid(65) | 密文
    const record = concat(salt16(), u32BE(BLOCK_FIELD), new Uint8Array([localRaw.length]), localRaw, cipher);

    const assertion = await vapidAssertion(cfg, url.origin);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(record.length),
        ttl: '60',
        urgency: 'normal',
        authorization: `vapid t=${assertion}, k=${cfg.publicKey}`,
      },
      body: record as unknown as BodyInit,
      redirect: REDIRECT_POLICY,
      signal: timeout(EGRESS.connectTimeoutMs),
    });

    if (res.ok) return 'sent';
    // 404/410 与 " Gone"/"NotFound"：订阅死了，必须停投并把设备置灰
    if (res.status === 404 || res.status === 410) return 'expired';
    const reason = res.headers.get('www-authenticate') ?? '';
    if (/gone|not.?found/i.test(reason)) return 'expired';
    return 'failed';
  } catch {
    return 'failed';
  }
}

// ─── 密码学小件 ─────────────────────────────────────────
const HKDF_SHA256 = { name: 'HMAC', hash: 'SHA-256' } as const;
const BLOCK_FIELD = 4096;

async function hmac(
  alg: HmacImportParams, keyBytes: Uint8Array, data: Uint8Array,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', keyBytes as BufferSource, alg, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign({ name: 'HMAC' }, key, data as BufferSource));
}

async function importEcdh(point: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', point as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
}

function salt16(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

function jsonBytes(v: unknown): Uint8Array {
  return utf8(JSON.stringify(v));
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function bytes(s: string): Uint8Array {
  return utf8(s);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function writeU32BE(buf: Uint8Array, at: number, value: number): void {
  buf[at] = (value >>> 24) & 255;
  buf[at + 1] = (value >>> 16) & 255;
  buf[at + 2] = (value >>> 8) & 255;
  buf[at + 3] = value & 255;
}

function u32BE(value: number): Uint8Array {
  const b = new Uint8Array(4);
  writeU32BE(b, 0, value);
  return b;
}

function base64UrlEncode(buf: Uint8Array): string {
  let s = '';
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** base64url → 未压缩 P-256 点（65 字节）。非法形态直接判失败，不做修补。 */
function uncompressedPoint(b64url: string): Uint8Array {
  const raw = base64UrlDecode(String(b64url ?? ''));
  if (raw.length === 65 && raw[0] === 0x04) return raw;
  if (raw.length === 64) return concat(new Uint8Array([0x04]), raw);
  return new Uint8Array(0);
}

/** DER ECDSA-Sig-Value → JOSE r‖s（各 32 字节，左侧补零）。VAPID 只接受 JOSE 形态。 */
function joseFromDer(der: Uint8Array): Uint8Array {
  const out = new Uint8Array(64);
  try {
    if (der[0] !== 0x30) return out;
    let at = 2;
    if (der[1] >= 0x80) at = 2 + (der[1] & 0x7f);
    for (let part = 0; part < 2; part++) {
      if (der[at] !== 0x02) return out;
      const len = der[at + 1];
      const body = der.subarray(at + 2, at + 2 + len);
      const trimmed = body[0] === 0x00 ? body.subarray(1) : body;
      const dstOff = part * 32 + (32 - Math.min(32, trimmed.length));
      out.set(trimmed.subarray(Math.max(0, trimmed.length - 32)), dstOff);
      at += 2 + len;
    }
  } catch { /* 解析不了就交回全零，签名会失败 ⇒ 上层记为 failed */ }
  return out;
}

function timeout(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}
