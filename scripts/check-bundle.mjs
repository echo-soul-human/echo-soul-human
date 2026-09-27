#!/usr/bin/env node
/**
 * check-bundle.mjs — 首屏体积预算（CI 硬失败）
 *
 * 预算来源：docs/分册-网页端.md §10。
 * 超预算按 bug 处理，不是"以后优化" —— 这个产品的主要用户从手机浏览器进入，
 * 首屏慢 1 秒就直接影响北极星指标（首次对话完成率）。
 *
 * 在 web/ 目录下执行（构建产物在 dist/）。
 */
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const OUT = process.argv[2] ?? 'dist';
const BUDGET = {
  /** 首屏 JS：入口 chunk + 其直接依赖的 vendor，gzip 合计 */
  jsGzip: 180 * 1024,
  cssGzip: 40 * 1024,
  /** 单个异步 chunk 上限，防止某个 feature 胖成一个包 */
  singleChunk: 250 * 1024,
};

if (!existsSync(OUT)) {
  console.error(`✗ 找不到构建产物 ${OUT}（先跑 npm run build）`);
  process.exit(1);
}

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const files = [...walk(OUT)];
const size = (p) => gzipSync(readFileSync(p)).length;

const js = files.filter((f) => f.endsWith('.js'));
const css = files.filter((f) => f.endsWith('.css'));

// 入口 chunk：被 index.html 直接引用的那些
const htmlPath = join(OUT, 'index.html');
const entryChunks = new Set();
if (existsSync(htmlPath)) {
  const html = readFileSync(htmlPath, 'utf8');
  for (const m of html.matchAll(/(?:src|href)="([^"]+\.css|[^"]+\.js)"/g)) {
    const rel = m[1].replace(/^\.?\//, '');
    const hit = files.find((f) => f.replace(/\\/g, '/').endsWith(rel));
    if (hit) entryChunks.add(hit);
  }
}

const firstPaintJs = [...entryChunks].filter((f) => f.endsWith('.js'));
const firstPaintCss = [...entryChunks].filter((f) => f.endsWith('.css'));

// 兜底：解析不出 index.html 引用时，按 vendor/entry 命名猜
const jsForBudget = firstPaintJs.length
  ? firstPaintJs
  : js.filter((f) => /assets\/(index|vendor|main|react)/i.test(f.replace(/\\/g, '/')));
const cssForBudget = firstPaintCss.length ? firstPaintCss : css;

const jsTotal = jsForBudget.reduce((n, f) => n + size(f), 0);
const cssTotal = cssForBudget.reduce((n, f) => n + size(f), 0);

const kb = (n) => (n / 1024).toFixed(1) + 'KB';
const rows = [];
let fail = false;

rows.push(['首屏 JS (gzip)', kb(jsTotal), kb(BUDGET.jsGzip), jsTotal <= BUDGET.jsGzip]);
rows.push(['首屏 CSS (gzip)', kb(cssTotal), kb(BUDGET.cssGzip), cssTotal <= BUDGET.cssGzip]);
fail ||= jsTotal > BUDGET.jsGzip || cssTotal > BUDGET.cssGzip;

for (const f of js) {
  const s = size(f);
  if (s > BUDGET.singleChunk) {
    rows.push([f.replace(OUT + '/', ''), kb(s), kb(BUDGET.singleChunk), false]);
    fail = true;
  }
}

console.log('\n构建产物体积（gzip）');
console.log('  ' + '指标'.padEnd(28) + '实际'.padStart(10) + '预算'.padStart(10) + '  结果');
for (const [name, actual, budget, ok] of rows) {
  console.log('  ' + name.padEnd(28) + actual.padStart(10) + budget.padStart(10) + '  ' + (ok ? '✓' : '✗'));
}
console.log(`\n  JS chunk 共 ${js.length} 个，总 gzip ${kb(js.reduce((n, f) => n + size(f), 0))}`);
console.log(`  字体文件 ${files.filter((f) => /\.(woff2?|ttf)$/.test(f)).length} 个`);

const fonts = files.filter((f) => /\.(woff2?|ttf)$/.test(f));
const fontTotal = fonts.reduce((n, f) => n + statSync(f).size, 0);
if (fontTotal > 1.2 * 1024 * 1024) {
  console.log(`  ✗ 字体合计 ${(fontTotal / 1024 / 1024).toFixed(2)}MB > 1.2MB 预算（必须子集化）`);
  fail = true;
} else if (fonts.length) {
  console.log(`  ✓ 字体合计 ${(fontTotal / 1024).toFixed(0)}KB`);
}

if (fail) {
  console.error('\n✗ 超出预算。见 docs/分册-网页端.md §10 的手段：路由级 lazy、重依赖异步、图片 WebP + 显式宽高。\n');
  process.exit(1);
}
console.log('\n✓ 体积预算全部达标');
