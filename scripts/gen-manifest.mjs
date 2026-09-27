#!/usr/bin/env node
/**
 * gen-manifest.mjs — 从根 manifest.json 生成各端版本产物
 *
 * 存在理由：HANDOFF §3-E4 定案「各端独立版本号但各自有约束」。
 * 约束的实现方式 = 只有一个地方能写版本号（manifest.json），
 * 其余全部生成。尚贤圈那次「装了新 APK 仍弹更新提示」的事故，
 * 根因就是版本号在两个文件各写一份。
 *
 * 生成物：
 *   web/public/manifest.webmanifest   PWA 清单
 *   web/public/version.json           运行时轮询用（更新提示）
 *   android/version.properties        安卓构建读取
 *   dist-meta/version.json            供 /version Edge Function 参考
 *
 * 用法：node scripts/gen-manifest.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { resolveBase } from './pages-base.mjs';

const ROOT = process.cwd();
const src = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

const { product, web, android } = src;

if (!product.slug) {
  console.error('\n✗ gen-manifest: product.slug 未定稿。');
  console.error('  包名 / 仓库名 / PWA name 一旦发布就改不动，先定名（docs/HANDOFF.md 附录 A）。\n');
  process.exit(1);
}

/**
 * base 必须等于 Pages 实际挂载路径，否则资源 404、PWA 装不上。
 * 仓库名等于 owner 时（profile / user-site 仓库）Pages 在**根路径**，
 * 普通仓库在 /<repo>/ —— 所以这里推导而不是照抄 manifest。
 */
const { base: BASE, source: BASE_SOURCE } = resolveBase({
  manifestPath: 'manifest.json', cwd: ROOT,
});

const ICONS = [
  { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
  { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
  { src: 'icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
  { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];

const webmanifest = {
  name: product.name,
  short_name: product.name,
  id: BASE,
  start_url: `${BASE}?src=homescreen`,
  scope: BASE,
  display: 'standalone',
  display_override: ['standalone', 'minimal-ui'],
  orientation: 'portrait',
  background_color: '#F7F3EC',
  theme_color: '#F7F3EC',
  lang: 'zh-CN',
  icons: ICONS,
  shortcuts: [
    { name: '继续上次对话', url: `${BASE}?s=resume` },
    { name: '新建角色', url: `${BASE}?a=new` },
  ],
};

const versionJson = {
  web: { build: web.build, force_refresh: web.force_refresh, notes_file: src.release_notes_file },
  android: {
    version_name: android.version_name,
    version_code: android.version_code,
    min_version_code: android.min_version_code,
  },
  generated_at: new Date().toISOString(),
};

const writes = [
  ['web/public/manifest.webmanifest', JSON.stringify(webmanifest, null, 2) + '\n'],
  ['web/public/version.json', JSON.stringify(versionJson, null, 2) + '\n'],
  ['android/version.properties', [
    '# 由 scripts/gen-manifest.mjs 生成，禁止手写',
    `versionName=${android.version_name}`,
    `versionCode=${android.version_code}`,
    `minVersionCode=${android.min_version_code}`,
    `abiFilters=${android.abi_filters.join(',')}`,
    '',
  ].join('\n')],
  ['web/src/app/version.ts', [
    '// 由 scripts/gen-manifest.mjs 生成，禁止手写',
    `export const APP_BUILD = ${JSON.stringify(web.build)};`,
    `export const APP_NAME = ${JSON.stringify(product.name)};`,
    `export const APP_SLUG = ${JSON.stringify(product.slug)};`,
    `export const BASE_PATH = ${JSON.stringify(BASE)};`,
    '',
  ].join('\n')],
];

for (const [relPath, body] of writes) {
  const abs = join(ROOT, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  console.log(`  ✓ ${relPath}`);
}

// base 形状校验：必须是 '/' 或 '/<repo>/'，不能带 query/hash，否则 PWA 装不上
if (BASE !== '/' && !/^\/[a-z0-9][a-z0-9._-]*\/$/.test(BASE)) {
  console.error(`\n✗ gen-manifest: base "${BASE}" 形状不合法（应为 "/" 或 "/<repo>/"，小写、无 query/hash）\n`);
  process.exit(1);
}
console.log(`  base = ${BASE}  (来源：${BASE_SOURCE})`);
if (BASE === '/') {
  console.log('  ℹ 根路径 = profile / user-site 仓库。注意该仓库的 README 会显示在你的 GitHub 个人主页上。');
}
console.log(`\n✓ gen-manifest: web ${web.build} · android ${android.version_name}(${android.version_code}) · ${product.slug}`);
