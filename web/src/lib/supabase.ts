/**
 * supabase.ts — 客户端与鉴权
 *
 * ★ 这里只允许出现**公开键**（anon / publishable）。
 *   service_role 与任何模型 Key 都不得进入前端包 —— deploy-web.yml 里
 *   有一道 dist 扫描专门拦这件事。数据隔离靠 RLS，不靠"不给接口"。
 *
 * ★ 演示模式（?demo=1）会整体替换成离线垫片，让界面在后端未接通时也能看。
 *   替换点选在这里而不是给 rpc.ts 里每个函数加分支：那样要改二十处，
 *   每加一个接口就漏一处。见 dev/demoClient.ts。
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { demoMode, createDemoClient } from '../dev/demoClient';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/**
 * 配置问题在这里只做**判定**，不做 throw。
 * 在模块顶层 throw 会发生在 import 阶段 —— React 还没挂载，
 * 用户看到的就是纯白屏，线上除浏览器控制台外没有任何线索，
 * 排查成本比页面本身还高。由 main.tsx 在挂载前读取它并渲染可见失败页。
 */
export const supabaseConfigError: string | null =
  !url || !anonKey
    ? '缺少 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY —— 部署侧的 Actions secrets 没配'
    : !/^(https?:)?\/\//.test(url)
      ? `VITE_SUPABASE_URL 格式不对（收到 ${url}），应形如 https://<ref>.supabase.co`
      : null;

// 守卫之后统一收窄成非空，避免每个使用点都要再判一次
const BASE_URL: string = supabaseConfigError ? 'http://127.0.0.1' : url!;

/** 是否处于离线演示模式 */
export const IS_DEMO = demoMode();

function realClient(): SupabaseClient {
  return createClient(BASE_URL, anonKey!, {
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
}

/**
 * 未配置时仍然不静默：任何一次真实使用都立刻抛错。
 * 正常路径下 main.tsx 根本不会挂载，用不到它。
 */
export const supabase: SupabaseClient = IS_DEMO
  ? (createDemoClient() as SupabaseClient)
  : supabaseConfigError
    ? new Proxy({} as SupabaseClient, {
        get(): never { throw new Error(supabaseConfigError!); },
      })
    : realClient();

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
