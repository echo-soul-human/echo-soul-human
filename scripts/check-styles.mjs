#!/usr/bin/env node
/**
 * check-styles.mjs — 手写样式禁止硬编码颜色与 px 字号（开发任务 0-15）
 *
 * 为什么值得守：皮肤是按档位卖的商品（§4.4），而皮肤系统的全部实现方式就是
 * 换 `--c-*` 变量。任何一处写死 `#E3D8D0`，用户换了皮肤那一处就不跟着变 ——
 * 而且是"看起来正常、只有某个皮肤下不对"的那种漏法，肉眼验收基本抓不到。
 *
 * 零依赖而不是引 stylelint：本仓库其余守卫（check-sql / check-prefix /
 * check-icons / audit-sw）都是手写 .mjs，引框架会让 CI 与本地行为分叉。
 *
 * 字号同样收进阶梯：一处改大要搜 33 处，而 --fs-input 低于 16px 会让 iOS
 * 聚焦输入框时自动放大页面且不缩回 —— 那是有名字才守得住的约束。
 *
 * 用法：node scripts/check-styles.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'web', 'src');

/** 允许出现字面色值与 px 字号的文件：token 层本身 */
const ALLOW = [
  /\.generated\./,                       // 设计 token 生成物，色值的唯一归宿
  /styles[\\/]type\.css$/,               // 字号阶梯，px 值的唯一归宿
  /styles[\\/]tokens/,                   // 手写 token 兜底（若将来出现）
];

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const FUNC = /\b(?:rgba?|hsla?|hwb|lab|lch|color)\s*\(/g;
/** font-size 只许引用 --fs-*：低于 16px 的输入框会让 iOS 聚焦时自动放大且不缩回 */
const PX_FONT_SIZE = /font-size:\s*[\d.]+px/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(css|tsx|ts)$/.test(name)) out.push(p);
  }
  return out;
}

const problems = [];
let checkedFiles = 0;

for (const file of walk(SRC)) {
  const rel = relative(ROOT, file);
  if (ALLOW.some((re) => re.test(rel))) continue;
  checkedFiles++;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) return;   // 注释行不算
    const hits = [...line.matchAll(HEX), ...line.matchAll(FUNC), ...line.matchAll(PX_FONT_SIZE)];
    for (const h of hits) {
      const isPx = h[0].startsWith('font-size');
      problems.push(`${rel}:${i + 1}  ${h[0]}  →  ${isPx ? '用 var(--fs-*) 阶梯' : '用 var(--c-*)'}  ${t.slice(0, 60)}`);
    }
  });
}

if (problems.length) {
  console.error(`\n✗ check-styles: ${problems.length} 处硬编码颜色\n`);
  for (const p of problems.slice(0, 40)) console.error('  - ' + p);
  if (problems.length > 40) console.error(`  …另有 ${problems.length - 40} 处`);
  console.error('\n  皮肤靠 --c-* 变量切换，写死的色值不会跟着换肤，');
  console.error('  而且只在某个皮肤下才看得出来 —— 肉眼验收抓不到这种漏法。');
  console.error('  token 清单见 web/src/styles/tokens.generated.css\n');
  process.exit(1);
}
console.log(`✓ check-styles: ${checkedFiles} 个手写样式/组件文件无硬编码颜色`);
