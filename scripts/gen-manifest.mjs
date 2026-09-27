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

const ROOT = process.cwd();
const src = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

const { product, web, android } = src;

if (!product.slug) {
  console.error('\n✗ gen-manifest: product.slug 未定稿。');
  console.error('  包名 / 仓库名 / PWA name 一旦发布就改不动，先定名（docs/HANDOFF.md 附录 A）。\n');
  process.exit(1);
}

const ICONS = [
  { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
  { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
  { src: 'icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
  { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];

const webmanifest = {
  name: product.name,
  short_name: product.name,
  id: web.base_path,
  start_url: `${web.base_path}?src=homescreen`,
  scope: web.base_path,
  display: 'standalone',
  display_override: ['standalone', 'minimal-ui'],
  orientation: 'portrait',
  background_color: '#F7F3EC',
  theme_color: '#F7F3EC',
  lang: 'zh-CN',
  icons: ICONS,
  shortcuts: [
    { name: '继续上次对话', url: `${web.base_path}?s=resume` },
    { name: '新建角色', url: `${web.base_path}?a=new` },
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
    `export const BASE_PATH = ${JSON.stringify(web.base_path)};`,
    '',
  ].join('\n')],
];

for (const [relPath, body] of writes) {
  const abs = join(ROOT, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  console.log(`  ✓ ${relPath}`);
}

// 一致性自检：三处路径必须完全相同，否则 PWA 装不上或 scope 越界
const paths = new Set([webmanifest.id, webmanifest.scope, web.base_path]);
if (paths.size !== 1) {
  console.error('\n✗ gen-manifest: id / scope / base_path 不一致 → PWA 安装状态会丢失\n');
  process.exit(1);
}
console.log(`\n✓ gen-manifest: web ${web.build} · android ${android.version_name}(${android.version_code}) · ${product.slug}`);
