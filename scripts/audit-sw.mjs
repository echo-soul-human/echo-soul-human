#!/usr/bin/env node
/**
 * audit-sw.mjs — Service Worker 职责审计（CI 硬失败）
 *
 * 存在理由：用户定案（HANDOFF §3-B4）「SW 只做 Web Push 与版本更新提示，
 * 禁止引入任何缓存层」。这条会被后来人当成"优化空间"顺手加回来，
 * 而一旦加了缓存，GitHub Pages 的边缘刷新延迟就会造成
 * 「用户看到旧 UI 但接口是新的」这种最难查的一类 bug。
 *
 * 所以：不是文档里写一句"别缓存"，而是缓存一出现就让 CI 红。
 *
 * 用法：node scripts/audit-sw.mjs
 */
import { readFileSync, existsSync } from 'node:fs';

const FILES = ['web/src/sw.ts', 'web/public/sw.js', 'web/sw.ts'];

const FORBIDDEN = [
  { re: /caches\.open\s*\(/g, why: 'caches.open() —— 打开了缓存' },
  { re: /caches\.match\s*\(/g, why: 'caches.match() —— 从缓存读取' },
  { re: /caches\.addAll\s*\(/g, why: 'caches.addAll() —— 预缓存清单' },
  { re: /caches\.delete\s*\(/g, why: 'caches.delete() —— 通常意味着存在缓存层' },
  { re: /addEventListener\s*\(\s*['"]fetch['"]/g, why: "fetch 事件拦截 —— 缓存层的典型入口" },
  { re: /onfetch\b/g, why: 'onfetch 赋值 —— 同上' },
  { re: /workbox/i, why: '引入 Workbox —— 本项目不用缓存框架' },
  { re: /\bcacheFirst\b|\bnetworkFirst\b|\bstaleWhileRevalidate\b|\sprecache\b/i, why: '缓存策略名 —— 说明有缓存层' },
];

const ALLOWED = [
  /addEventListener\s*\(\s*['"]push['"]/g,
  /addEventListener\s*\(\s*['"]notificationclick['"]/g,
  /addEventListener\s*\(\s*['"]message['"]/g,
  /self\.skipWaiting\s*\(\s*\)/g,
  /clients\.matchAll/g,
  /registration\.showNotification/g,
];

const found = [];
let checked = 0;

for (const f of FILES) {
  if (!existsSync(f)) continue;
  checked++;
  const src = readFileSync(f, 'utf8');
  // 逐行判定，跳过注释
  src.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    for (const b of FORBIDDEN) {
      b.re.lastIndex = 0;
      if (b.re.test(line)) found.push(`${f}:${i + 1}  ${b.why}`);
    }
  });
}

if (checked === 0) {
  console.error('✗ audit-sw: 找不到任何 SW 文件。PWA 推送依赖它。');
  process.exit(1);
}

if (found.length) {
  console.error(`\n✗ audit-sw: SW 里出现了缓存逻辑，违反定案 HANDOFF §3-B4\n`);
  for (const e of found) console.error('  ' + e);
  console.error(`\n  本项目 SW 只允许承担：push / notificationclick / message(skipWaiting)。`);
  console.error(`  离线不可用是「接受的取舍」，不是待修缺陷（见 docs/分册-网页端.md §6.2）。`);
  console.error(`  允许清单：${ALLOWED.length} 类调用。\n`);
  process.exit(1);
}
console.log(`✓ audit-sw: ${checked} 个 SW 文件无缓存逻辑，职责限定在推送与更新提示`);
