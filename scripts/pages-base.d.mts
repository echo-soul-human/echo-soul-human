/**
 * pages-base.d.ts — 给 vite.config.ts 用的类型声明
 *
 * 实现是 .mjs（Node 脚本），但会被 vite.config.ts import。
 * 不写这份声明的话，在 tsconfig 的 strict 下会报隐式 any。
 */
export interface ResolveBaseOptions {
  env?: Record<string, string | undefined>;
  manifestPath?: string;
  cwd?: string;
}

export interface ResolvedBase {
  base: string;
  source: 'ECHOSOUL_BASE' | 'GITHUB_REPOSITORY' | 'manifest.web.base_path' | 'default';
}

export function normalizeBase(p: string | undefined | null): string;
export function baseFromRepository(env?: Record<string, string | undefined>): string | null;
export function resolveBase(options?: ResolveBaseOptions): ResolvedBase;
