/**
 * _shared/afdian.ts — 爱发电开放平台客户端
 *
 * 依据：爱发电开发者文档（Webhook / API / OAuth2 三部分），2026-09-27 版本。
 *
 * 两套签名，别混：
 *   · API  签名 = md5(token + "params"+params+"ts"+ts+"user_id"+user_id)   ← 我们主动查单
 *   · Webhook 签名 = RSA-SHA256(out_trade_no + user_id + plan_id + total_amount) ← 平台推给我们
 *
 * 文档明确提示：「如果服务器异常，可能不保证能及时推送，因此建议结合 API 一起使用」。
 * 所以本模块同时提供 webhook 验签与 API 轮询，两条路走同一套幂等发放逻辑。
 */
import { md5 } from './md5.ts';

export const AFDIAN_API = 'https://ifdian.net/api/open';
export const AFDIAN_OAUTH = 'https://ifdian.net/api/oauth2';

/** 爱发电开发者公钥（公开信息，用于验签 webhook；可入库） */
export const AFDIAN_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwwdaCg1Bt+UKZKs0R54y
lYnuANma49IpgoOwNmk3a0rhg/PQuhUJ0EOZSowIC44l0K3+fqGns3Ygi4AfmEfS
4EKbdk1ahSxu7Zkp2rHMt+R9GarQFQkwSS/5x1dYiHNVMiR8oIXDgjmvxuNes2Cr
8fw9dEF0xNBKdkKgG2qAawcN1nZrdyaKWtPVT9m2Hl0ddOO9thZmVLFOb9NVzgYf
jEgI+KWX6aY19Ka/ghv/L4t1IXmz9pctablN5S0CRWpJW3Cn0k6zSXgjVdKm4uN7
jRlgSRaf/Ind46vMCm3N2sgwxu/g3bnooW+db0iLo13zzuvyn727Q3UDQ0MmZcEW
MQIDAQAB
-----END PUBLIC KEY-----`;

/** 订单状态：文档「目前仅会推送 status=2 交易成功」 */
export const ORDER_PAID = 2;

export interface AfdianOrder {
  out_trade_no: string;
  custom_order_id?: string;
  user_id: string;
  user_private_id?: string;
  plan_id: string;              // 自选方案时为空串
  month: number;
  total_amount: string;         // 真实付款额（兑换码支付时为 "0.00"）
  show_amount: string;
  status: number;
  remark: string;
  redeem_id: string;
  product_type: number;         // 0 常规订阅 · 1 售卖
  discount: string;
  sku_detail?: Array<{ sku_id: string; count: number; name: string; album_id?: string; pic?: string }>;
  address_person?: string;
  address_phone?: string;
  address_address?: string;
}

export interface AfdianResponse<T> {
  ec: number;
  em: string;
  data?: T;
}

/** ec 错误码表（文档给出） */
export const EC = {
  OK: 200,
  PARAMS_INCOMPLETE: 400001,
  TS_EXPIRED: 400002,
  PARAMS_NOT_JSON: 400003,
  NO_VALID_TOKEN: 400004,
  SIGN_FAILED: 400005,
} as const;

// ─── API 签名 ────────────────────────────────────────────
/**
 * sign = md5({token}params{params}ts{ts}user_id{user_id})
 *
 * ⚠️ 三个容易错的点：
 *   1. token 直接写值、**不作为 kv 对**出现，只有后面三个参数写 kv
 *   2. 无任何连接符，直接拼接
 *   3. params 是**序列化后的 JSON 字符串本身**，键序必须与签名时一致
 *      —— 所以本函数内部统一用 stableStringify，调用方不要自己 JSON.stringify
 */
export function apiSign(token: string, paramsJson: string, ts: number, userId: string): string {
  return md5(`${token}params${paramsJson}ts${ts}user_id${userId}`);
}

/** 键排序后序列化，保证签名串与请求串完全一致 */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as any)[k])}`).join(',')}}`;
}

export interface ClientCfg {
  userId: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export class AfdianClient {
  // 刻意不用 `constructor(private cfg)` 这种 parameter property：
  // Node 的 type-stripping 不支持它，会让签名逻辑没法在 CI 里跑真实单测。
  private readonly cfg: ClientCfg;

  constructor(cfg: ClientCfg) {
    this.cfg = cfg;
  }

  static fromEnv(): AfdianClient {
    const userId = Deno.env.get('AFDIAN_USER_ID');
    const token = Deno.env.get('AFDIAN_API_TOKEN');
    if (!userId || !token) throw new Error('AFDIAN_USER_ID / AFDIAN_API_TOKEN not configured');
    return new AfdianClient({ userId, token });
  }

  private async post<T>(path: string, params: Record<string, unknown>): Promise<AfdianResponse<T>> {
    const ts = Math.floor(Date.now() / 1000);
    const paramsJson = stableStringify(params);
    const body = {
      user_id: this.cfg.userId,
      params: paramsJson,
      ts,
      sign: apiSign(this.cfg.token, paramsJson, ts, this.cfg.userId),
    };

    const res = await (this.cfg.fetchImpl ?? fetch)(`${AFDIAN_API}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
    });

    if (!res.ok) throw new Error(`afdian http ${res.status} on ${path}`);
    const json = (await res.json()) as AfdianResponse<T>;

    // 400002 ts 过期允许一次重试（服务器时钟漂移是常见原因）
    if (json.ec === EC.TS_EXPIRED) {
      const ts2 = Math.floor(Date.now() / 1000);
      const body2 = { ...body, ts: ts2, sign: apiSign(this.cfg.token, paramsJson, ts2, this.cfg.userId) };
      const r2 = await (this.cfg.fetchImpl ?? fetch)(`${AFDIAN_API}/${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body2), redirect: 'error',
      });
      return (await r2.json()) as AfdianResponse<T>;
    }
    return json;
  }

  /** 签名自检。文档说明失败时会回传 debug.kv_string，便于离线核对 */
  async ping(): Promise<AfdianResponse<unknown>> {
    return this.post('ping', {});
  }

  /** 查订单：page 或 out_trade_no 二选一（可逗号分隔多个订单号） */
  async queryOrder(o: { page?: number; out_trade_no?: string; per_page?: number }) {
    const params: Record<string, unknown> = {};
    if (o.page !== undefined) params.page = o.page;
    if (o.out_trade_no) params.out_trade_no = o.out_trade_no;
    if (o.per_page) params.per_page = clamp(o.per_page, 1, 100);
    return this.post<{ list: AfdianOrder[]; total_count: number; total_page: number }>('query-order', params);
  }

  /** 查赞助者：可按爱发电 user_id 过滤，用于 L2/L3 归因兜底 */
  async querySponsor(o: { page?: number; user_id?: string; per_page?: number }) {
    const params: Record<string, unknown> = {};
    if (o.page !== undefined) params.page = o.page;
    if (o.user_id) params.user_id = o.user_id;
    if (o.per_page) params.per_page = clamp(o.per_page, 1, 100);
    return this.post<{ list: unknown[]; total_count: number; total_page: number }>('query-sponsor', params);
  }

  async queryPlan(plan_id: string) {
    return this.post<{ plan: unknown }>('query-plan', { plan_id });
  }
}

// ─── Webhook 验签 ───────────────────────────────────────
/**
 * 文档：签名数据为 order 中 out_trade_no、user_id、plan_id、total_amount
 * **依次拼接**成的字符串；sign 在 data.sign（不在 order 内）。
 */
export function webhookSignStr(o: AfdianOrder): string {
  return `${o.out_trade_no ?? ''}${o.user_id ?? ''}${o.plan_id ?? ''}${o.total_amount ?? ''}`;
}

let pubKeyPromise: Promise<CryptoKey> | null = null;
function publicKey(): Promise<CryptoKey> {
  if (!pubKeyPromise) {
    pubKeyPromise = (async () => {
      const der = pemToDer(AFDIAN_PUBLIC_KEY_PEM);
      // openssl_verify(..., OPENSSL_ALGO_SHA256) == RSASSA-PKCS1-v1_5 + SHA-256
      return crypto.subtle.importKey(
        'spki', der as BufferSource,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false, ['verify'],
      );
    })();
  }
  return pubKeyPromise;
}

export async function verifyWebhookSign(order: AfdianOrder, sign: string | undefined): Promise<boolean> {
  if (!sign) return false;
  try {
    const key = await publicKey();
    const sig = Uint8Array.from(atob(sign), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', key, sig as BufferSource,
      new TextEncoder().encode(webhookSignStr(order)),
    );
  } catch {
    return false;
  }
}

function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ─── 归因：订单 → 我们的档位 ─────────────────────────────
export type AttributeResult =
  | { ok: true; userId: string; via: 'oauth' | 'email' | 'manual'; planId: string }
  | { ok: false; reason: 'no_binding' | 'unknown_plan' | 'zero_amount' | 'not_paid' };

/**
 * 归因优先级（docs/分册-模型与计费.md §5.2，用户定案：无二维码、无兑换码、不找客服）
 *   L1 afdian_user_id 绑定（用户用爱发电登录过本服务）
 *   L2 订单里的 custom_order_id / remark 中的显式标识
 *   L3 查不到 → 落 unmatched_orders，用户在产品内点"我付了但没到账"触发重查
 */
export async function attributeOrder(
  supabase: { from: (t: string) => any },
  order: AfdianOrder,
): Promise<AttributeResult> {
  if (order.status !== ORDER_PAID) return { ok: false, reason: 'not_paid' };

  // 商品目录必须能认出这个 plan_id，否则不知道发什么档位
  const { data: plan } = await supabase.from('plan_catalog')
    .select('id, tier, afdian_plan_id').eq('afdian_plan_id', order.plan_id).maybeSingle();
  if (!plan) return { ok: false, reason: 'unknown_plan' };

  // total_amount 为 0 表示用兑换码支付，金额不可信，交人工核（后台队列，不打扰用户）
  if (Number(order.total_amount) <= 0) return { ok: false, reason: 'zero_amount' };

  const { data: bound } = await supabase.from('profiles')
    .select('id').eq('afdian_user_id', order.user_id).maybeSingle();
  if (bound) return { ok: true, userId: bound.id, via: 'oauth', planId: plan.id };

  const hint = extractUserIdHint(order.custom_order_id) ?? extractUserIdHint(order.remark);
  if (hint) {
    const { data: byHint } = await supabase.from('profiles').select('id').eq('id', hint).maybeSingle();
    if (byHint) return { ok: true, userId: byHint.id, via: 'manual', planId: plan.id };
  }

  return { ok: false, reason: 'no_binding' };
}

/** 只接受 UUID 形态的提示，避免把用户随手写的备注当成标识 */
function extractUserIdHint(s?: string): string | null {
  if (!s) return null;
  const m = String(s).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0].toLowerCase() : null;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}
