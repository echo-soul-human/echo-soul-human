/**
 * pages-base.mjs — 推导 GitHub Pages 的 base 路径
 *
 * 为什么必须推导而不是写死：base 错了的症状是**整站白屏且没有任何报错**
 * （资源 404 但 index.html 能开），是极难排查的一类问题。
 *
 * 优先级：ECHOSOUL_BASE 显式 > GITHUB_REPOSITORY > git remote origin > manifest > 默认
 * 后两条保证「本地」与「CI」推导出同一个值 —— 否则 CI 的
 * "生成物是否最新"检查会因为环境差异而必然失败。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export function normalizeBase(p) {
  if (!p || p === '/' || p === '') return '/';
  const s = p.startsWith('/') ? p : '/' + p;
  return s.endsWith('/') ? s : s + '/';
}

/** 从 GITHUB_REPOSITORY（"owner/repo"）推导；非 CI 环境返回 null */
export function baseFromRepository(env = process.env) {
  const repo = env?.GITHUB_REPOSITORY;
  if (!repo || !repo.includes('/')) return null;
  const [, name] = repo.split('/');
  return normalizeBase('/' + name);
}

/**
 * ⚠ 这里刻意**不**假设"仓库名等于 owner 就走根路径"。
 * 那个假设已被实测证伪：echo-soul-human/echo-soul-human 这个仓库，
 * GitHub Pages API 返回的 html_url 是
 *   https://echo-soul-human.github.io/echo-soul-human/
 * —— 项目页，不是用户页。
 * 所以默认一律 /<repo>/；确实是用户站仓库时用 ECHOSOUL_BASE=/ 显式声明。
 * 核实真实路径的权威方法：GET /repos/{owner}/{repo}/pages 看 html_url。
 */

/** 匹配 github.com 的 ssh 与 https 两种 remote 形态 */
const REMOTE_RE = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?\s*$/i;

/** 解析 remote URL 取仓库名；非 github 或形状不对返回 null */
export function baseFromRemoteUrl(url) {
  const m = REMOTE_RE.exec(String(url ?? '').trim());
  return m ? normalizeBase('/' + m[2]) : null;
}

/** 从 git remote origin 推导 base；不是 git 仓库、没有 origin 或不是 github 返回 null */
export function baseFromGitRemote(cwd = process.cwd()) {
  let url;
  try {
    url = execFileSync('git', ['remote', 'get-url', 'origin'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;                        // 不是 git 仓库 / 没有 origin
  }
  return baseFromRemoteUrl(url);
}

export function resolveBase({ env = process.env, manifestPath, cwd = process.cwd() } = {}) {
  if (env && env.ECHOSOUL_BASE) {
    return { base: normalizeBase(env.ECHOSOUL_BASE), source: 'ECHOSOUL_BASE' };
  }

  const derived = baseFromRepository(env);
  if (derived) return { base: derived, source: 'GITHUB_REPOSITORY' };

  const viaRemote = baseFromGitRemote(cwd);
  if (viaRemote) return { base: viaRemote, source: 'git remote origin' };

  if (manifestPath) {
    try {
      const m = JSON.parse(readFileSync(join(cwd, manifestPath), 'utf8'));
      const b = normalizeBase(m?.web?.base_path);
      if (b !== '/') return { base: b, source: 'manifest.web.base_path' };
    } catch { /* 落到默认 */ }
  }
  return { base: '/echosoul/', source: 'default' };
}
