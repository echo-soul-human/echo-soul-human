#!/usr/bin/env node
/**
 * gen-tokens.mjs — 设计 token 单一源 → 各端产物
 *
 * 存在理由（docs/分册-网页端.md §3）：皮肤是**商品**，
 * 商品 = 对 token 的一份覆盖文件。所以 token 必须是唯一真源，
 * 各端只能消费生成物，禁止手写色值。
 *
 * 产物：
 *   web/src/styles/tokens.generated.css   :root 变量（三层）
 *   web/src/app/tokens.ts                 TS 常量（供 JS 逻辑读取，如对比度校验）
 *   android/.../ui/design/DesignTokens.kt Kotlin 颜色与尺寸
 *
 * 用法：node scripts/gen-tokens.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'shared/tokens/design.tokens.json');
const raw = JSON.parse(readFileSync(SRC, 'utf8'));

/** 解析 {tier1.color.paper} 这类引用；解析不了直接失败，不要静默留原样 */
function resolve(value, lookup, path) {
  if (typeof value !== 'string') return value;
  const m = value.match(/^\{(.+)\}$/);
  if (!m) return value;
  const key = m[1];
  if (!(key in lookup)) {
    console.error(`✗ ${path}: 引用了不存在的 token {${key}}`);
    process.exit(1);
  }
  return lookup[key];
}

/**
 * 递归收集叶子 token。
 * tier1 是「组 → 值」两层（color/font/space/...），
 * tier2 与 tier3 是「键 → 值」一层。
 * ⚠ 不能对所有层都固定两层遍历：对字符串做 Object.entries 会逐字符展开。
 */
function walk(node, path, out) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    out.push([path.join('.'), node]);
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('_')) continue;               // 注释字段
    walk(v, [...path, k], out);
  }
}

/** 按 tier 顺序产出 [varName, value, sourceKey] */
const leaves = [];
for (const tier of ['tier1', 'tier2', 'tier3']) {
  walk(raw[tier] ?? {}, [tier], leaves);
}

const lookup = {};
for (const [key, value] of leaves) {
  lookup[key] = resolve(value, lookup, key);
}

/**
 * 变量名取路径最后一段，前缀由它的**直接父节点**决定：
 *   tier1.color.paper-warm → --c-paper-warm
 *   tier1.space.3          → --sp-3
 *   tier1.font.body        → --f-body
 *   tier2.surface-raised   → --surface-raised   （tier2 是一层，父就是 tier2）
 *   tier3.bubble-user-bg   → --bubble-user-bg
 */
const GROUP_PREFIX = {
  color: '--c', font: '--f', space: '--sp', radius: '--r',
  duration: '--t', easing: '--ease',
};
function cssVarName(key) {
  const parts = key.split('.');
  const name = parts[parts.length - 1];
  const parent = parts.length >= 3 ? parts[parts.length - 2] : null;
  const prefix = parent ? GROUP_PREFIX[parent] : undefined;
  return prefix ? `${prefix}-${name}` : `--${name}`;
}

function entriesFor(tier) {
  return leaves
    .filter(([k]) => k.startsWith(tier + '.'))
    .map(([k]) => [cssVarName(k), lookup[k], k]);
}

const lines = [];
lines.push('/* 由 scripts/gen-tokens.mjs 生成 —— 禁止手工编辑。');
lines.push('   改 token 请改 shared/tokens/design.tokens.json 然后重跑 npm run gen:tokens。');
lines.push('   皮肤 = 对 tier1/tier2 的覆盖；组件只允许消费 tier3。');
lines.push('   组件里出现十六进制色值会被 stylelint 拦下。 */');
lines.push('');
lines.push(':root {');
for (const tier of ['tier1', 'tier2', 'tier3']) {
  lines.push(`  /* ── ${tier} ── */`);
  for (const [v, val] of entriesFor(tier)) lines.push(`  ${v}: ${val};`);
  lines.push('');
}
lines.push('  /* 组件禁止硬编码，一律走上面三层 */');
lines.push('}');
lines.push('');
lines.push('/* 减弱动效：全局把时长压到 0，动效曲线保留但不产生位移 */');
lines.push('@media (prefers-reduced-motion: reduce) {');
lines.push('  :root { --t-fast: 0ms; --t-base: 0ms; --t-slow: 0ms; }');
lines.push('  *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }');
lines.push('}');
lines.push('');

const CSS_OUT = join(ROOT, 'web/src/styles/tokens.generated.css');
mkdirSync(dirname(CSS_OUT), { recursive: true });
writeFileSync(CSS_OUT, lines.join('\n'));

// ── TS 常量（供运行时逻辑读取，例如皮肤对比度校验、分享图渲染）──
const tsOut = [];
tsOut.push('// 由 scripts/gen-tokens.mjs 生成 —— 禁止手工编辑');
tsOut.push('export const TOKENS = {');
for (const tier of ['tier1', 'tier2', 'tier3']) {
  tsOut.push(`  ${tier}: {`);
  for (const [, val, key] of entriesFor(tier)) {
    tsOut.push(`    ${JSON.stringify(key.split('.').slice(1).join('.'))}: ${JSON.stringify(val)},`);
  }
  tsOut.push('  },');
}
tsOut.push('} as const;');
tsOut.push('');
tsOut.push('export type TokenKey = keyof typeof TOKENS.tier1 & keyof typeof TOKENS.tier2 & keyof typeof TOKENS.tier3;');
tsOut.push('');
const TS_OUT = join(ROOT, 'web/src/app/tokens.generated.ts');
writeFileSync(TS_OUT, tsOut.join('\n'));

// ── Kotlin（安卓侧不吃 Material 动态取色，见 docs/分册-安卓端.md §9）──
const hex = (v) => {
  const m = /^#([0-9a-f]{6})$/i.exec(String(v));
  return m ? `0xFF${m[1].toUpperCase()}u` : null;
};
const kt = [];
kt.push('/** 由 scripts/gen-tokens.mjs 生成 —— 禁止手工编辑 */');
kt.push('package com.echosoul.app.ui.design');
kt.push('');
kt.push('import androidx.compose.ui.graphics.Color');
kt.push('import androidx.compose.ui.unit.dp');
kt.push('import androidx.compose.ui.unit.sp');
kt.push('');
kt.push('object Ink {');
for (const [, val, key] of entriesFor('tier1')) {
  const h = hex(val);
  if (h) kt.push(`    val ${key.split('.').pop().replace(/-/g, '_').replace(/^([0-9])/, 'n$1')}: Color(${h})`);
}
kt.push('}');
kt.push('');
kt.push('object Space {');
for (const [, val, key] of entriesFor('tier1')) {
  if (!key.includes('.space.')) continue;
  const n = parseFloat(String(val));
  if (Number.isFinite(n)) kt.push(`    val ${key.split('.').pop().replace(/^([0-9])/, 'n$1')}: ${n}.dp`);
}
kt.push('}');
kt.push('');
kt.push('/** 禁用 Material You 动态取色：跟随壁纸会毁掉品牌视觉一致性 */');
kt.push('const val USE_DYNAMIC_COLOR = false;');
kt.push('');
const KT_OUT = join(ROOT, 'android/app/src/main/java/com/echosoul/app/ui/design/DesignTokens.kt');
mkdirSync(dirname(KT_OUT), { recursive: true });
writeFileSync(KT_OUT, kt.join('\n'));

const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');
console.log(`✓ gen-tokens: ${Object.keys(lookup).length} 个 token`);
console.log(`  ${rel(CSS_OUT)}`);
console.log(`  ${rel(TS_OUT)}`);
console.log(`  ${rel(KT_OUT)}`);

// ── 自检：三层必须都存在，且 tier3 至少覆盖气泡与按钮 ──
const need = ['--bubble-user-bg', '--bubble-role-bg', '--button-primary-bg', '--surface', '--brand'];
const css = readFileSync(CSS_OUT, 'utf8');
const missing = need.filter((v) => !css.includes(v + ':'));
if (missing.length) {
  console.error(`\n✗ 生成物缺少关键变量：${missing.join(', ')}`);
  process.exit(1);
}
console.log('  ✓ 关键变量齐备');
