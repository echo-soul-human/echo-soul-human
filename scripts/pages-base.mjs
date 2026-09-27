/**
 * pages-base.mjs — 推导 GitHub Pages 的 base 路径
 *
 * 为什么必须自动推导而不是写死：
 *   仓库名等于 owner 时（profile 仓库 / user-site 仓库），Pages 挂在**根路径**
 *   https://<owner>.github.io/ ；普通项目仓库挂在 /<repo>/。
 *   写死其中一个，换仓库形态就整站 404，而且症状是"页面白屏没报错"，很难查。
 *
 * 优先级：显式 ECHOSOUL_BASE > GITHUB_REPOSITORY 推导 > manifest.web.base_path
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function normalizeBase(p) {
  if (!p || p === '/' || p === '') return '/';
  let s = p.startsWith('/') ? p : '/' + p;
  if (!s.endsWith('/')) s += '/';
  return s;
}

/** 从 GITHUB_REPOSITORY（"owner/repo"）推导；非 CI 环境返回 null */
export function baseFromRepository(env = process.env) {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo || !repo.includes('/')) return null;
  const [, name] = repo.split('/');
  return normalizeBase('/' + name);
}

/**
 * ⚠ 这里**不**再假设"仓库名等于 owner 就走根路径"。
 * 那个假设被实测证伪了：echo-soul-human/echo-soul-human 这个仓库，
 * GitHub Pages API 返回的是 https://echo-soul-human.github.io/echo-soul-human/
 * —— 项目页，不是用户页。猜错的表现是整站白屏且没有任何报错，很难查。
 *
 * 所以：默认一律 /<repo>/；确实是用户站仓库时显式设 ECHOSOUL_BASE=/ 。
 * 核实真实路径的权威方法：
 *   GET /repos/{owner}/{repo}/pages  →  看 html_url
 */

export function resolveBase({ env = process.env, manifestPath, cwd = process.cwd() } = {}) {
  if (env.ECHOSOUL_BASE) {
    return { base: normalizeBase(env.ECHOSOUL_BASE), source: 'ECHOSOUL_BASE' };
  }
  const derived = baseFromRepository(env);
  if (derived) return { base: derived, source: 'GITHUB_REPOSITORY' };

  if (manifestPath) {
    try {
      const m = JSON.parse(readFileSync(join(cwd, manifestPath), 'utf8'));
      return { base: normalizeBase(m?.web?.base_path), source: 'manifest.web.base_path' };
    } catch { /* 落到默认 */ }
  }
  return { base: '/echosoul/', source: 'default' };
}
