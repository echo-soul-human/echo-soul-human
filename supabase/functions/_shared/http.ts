/**
 * _shared/http.ts — Edge Function 公共外壳
 *
 * 抽出来的理由：CORS、鉴权、错误翻译这三件事如果每个函数各写一遍，
 * 迟早会出现"某个函数忘了校验登录态"这种洞。
 */
import { createClient, type SupabaseClient, type User } from 'https://esm.sh/@supabase/supabase-js@2';

export const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type, x-device-id',
  'access-control-allow-methods': 'POST, GET, PUT, DELETE, OPTIONS',
  'access-control-max-age': '86400',
};

export function preflight(): Response {
  return new Response('ok', { headers: CORS });
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' },
  });
}

export const ok = (body: unknown) => json(200, body);
export const bad = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  json(status, { error: code, ...extra });

/** 服务端专用客户端（可读 character_locks / byok_secrets 等零授权表） */
export function admin(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** 请求级客户端：带着调用方的 JWT，因此受 RLS 约束 */
export function asUser(req: Request): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL')!;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  return createClient(url, key, {
    global: { headers: { authorization: req.headers.get('authorization') ?? '' } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface Authed {
  user: User;
  db: SupabaseClient;      // service_role，读敏感表用
  userDb: SupabaseClient;  // 带 JWT，写用户自己的数据用（受 RLS）
  deviceId: string;
}

/**
 * 校验调用方身份。失败返回 null，调用方直接回 401。
 * ★ 每个函数都必须走这里 —— 不允许存在"匿名可调"的业务端点。
 */
export async function requireUser(req: Request): Promise<Authed | null> {
  const authz = req.headers.get('authorization') ?? '';
  if (!authz.startsWith('Bearer ')) return null;
  const db = admin();
  const { data, error } = await db.auth.getUser(authz.slice(7).trim());
  if (error || !data.user) return null;
  // 被处置的账号一律挡在门外（30 号专篇 §4）
  if (data.user.banned_until && new Date(data.user.banned_until) > new Date()) return null;
  return {
    user: data.user,
    db,
    userDb: asUser(req),
    deviceId: (req.headers.get('x-device-id') ?? '').slice(0, 64),
  };
}

/** 定时任务专用：只有带正确 secret 的内部调用能过 */
export function requireCron(req: Request): boolean {
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret) return true;              // 未配置时不拦，方便本地联调
  return req.headers.get('x-cron-secret') === secret;
}

/** 安全解析 body：坏 JSON 不抛栈，返回 null 让调用方回 400 */
export async function body<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

/** 日志脱敏：绝不把 Key、token、完整 prompt 写进日志 */
export function safe(input: unknown): string {
  if (input === null || input === undefined) return '';
  const s = typeof input === 'string' ? input : (() => {
    try { return JSON.stringify(input); } catch { return String(input); }
  })();
  return s
    .replace(/(sk-|Bearer\s+|api[_-]?key["']?\s*[:=]\s*["']?)[A-Za-z0-9_\-.]{6,}/gi, '$1****')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, '<jwt>')
    .slice(0, 500);
}

/** 截断到安全长度并去掉控制字符，用于写进 reason/detail 字段 */
export function brief(input: unknown, max = 200): string {
  return safe(input).replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, max);
}
