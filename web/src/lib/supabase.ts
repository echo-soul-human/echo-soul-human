/**
 * supabase.ts — 客户端与鉴权
 *
 * ★ 这里只允许出现**公开键**（anon / publishable）。
 *   service_role 与任何模型 Key 都不得进入前端包 —— deploy-web.yml 里
 *   有一道 dist 扫描专门拦这件事。数据隔离靠 RLS，不靠"不给接口"。
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// 守卫之后统一收窄成非空，避免每个使用点都要再判一次

if (!url || !anonKey) {
  // 不静默降级：缺配置就明确报错，否则用户会看到"点了没反应"
  throw new Error('缺少 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY，请检查部署环境变量');
}

if (!/^(https?:)?\/\//.test(url)) {
  throw new Error('VITE_SUPABASE_URL 格式不对，应形如 https://<ref>.supabase.co');
}

const BASE_URL: string = url;

export const supabase: SupabaseClient = createClient(BASE_URL, anonKey, {
  auth: {
    // 会话存 localStorage。注意 iOS 会在 7 天不活跃后清理站点存储，
    // 因此不能把它当唯一真源 —— 数据本身在云端（E1 定案）。
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: 'echosoul.auth',
  },
  global: { headers: { 'x-client-info': 'echosoul-web' } },
});

/** Edge Function 调用地址 */
export function fnUrl(name: string): string {
  return `${BASE_URL.replace(/\/+$/, '')}/functions/v1/${name}`;
}

/** 取当前访问令牌；Edge Function 需要它来验明用户身份 */
export async function accessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const t = data.session?.access_token;
  if (!t) throw new Error('UNAUTHORIZED');
  return t;
}

/** 幂等键：每次"点发送"新建一个，重试时复用同一个（防重复扣费） */
export function newRequestId(): string {
  return crypto.randomUUID();
}
