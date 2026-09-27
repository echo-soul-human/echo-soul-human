/**
 * spa-404.d.mts — 给 vite.config.ts 用的类型声明
 * 实现是 .mjs（Node 脚本），不写声明在 strict 下会报隐式 any。
 */
export function spa404Script(base: string): string;
export function renderSpa404(base: string): string;
export function writeSpa404(outDir: string, base: string): string;
