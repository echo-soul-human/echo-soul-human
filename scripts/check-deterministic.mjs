#!/usr/bin/env node
/**
 * check-deterministic.mjs — 生成物必须确定性
 *
 * 存在理由：CI 里"生成物是否最新"那道检查，在生成器带时间戳时永远不可能绿。
 * 那次就是 gen-manifest 写了 generated_at: new Date() 导致必然失败 ——
 * 检查没错，是生成不确定。这道脚本把"确定性"本身变成可验证的约束。
 *
 * 做法：快照 → 重跑全部生成器 → 比对字节。
 * 用法：node scripts/gen-* 之外只跑这个：node scripts/check-deterministic.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const ROOT = process.cwd();

const GENERATED = [
  'supabase/functions/_shared/prefix.generated.ts',
  'supabase/functions/_shared/prefix.lock.json',
  'web/src/styles/tokens.generated.css',
  'web/src/app/tokens.generated.ts',
  'web/public/manifest.webmanifest',
  'web/public/version.json',
  'web/public/release-notes.json',
  'web/src/types/generated/api.ts',
  'android/version.properties',
  'android/app/src/main/java/com/echosoul/app/ui/design/DesignTokens.kt',
  'android/app/src/main/java/com/echosoul/app/api/Contract.kt',
  'web/src/app/version.ts',
  // 目录项：32 篇协议 JSON，逐条列不现实
  'web/public/legal/',
];

/** 生成物里出现这些键就说明不确定性又溜回来了 */
const NONDETERMINISTIC = [
  /generated_at/, /"generatedAt"\s*:/, /Date\.now\(\)/, /new Date\(\)\.toISOString/,
];

/** 展开目录项为其中全部文件（已排序，保证顺序可比） */
function expand(entries) {
  const out = [];
  for (const e of entries) {
    const abs = join(ROOT, e);
    if (!existsSync(abs)) { out.push(e); continue; }   // 缺失项原样保留，便于报错
    if (statSync(abs).isDirectory()) {
      for (const f of readdirSync(abs).sort()) out.push(`${e}${f}`.replace(/\\/g, '/'));
    } else {
      out.push(e);
    }
  }
  return out;
}

const FILES = expand(GENERATED);

function sha(p) {
  if (!existsSync(join(ROOT, p))) return '<missing>';
  return createHash('sha256').update(readFileSync(join(ROOT, p))).digest('hex');
}

const problems = [];

for (const p of FILES) {
  if (!existsSync(join(ROOT, p))) { problems.push(`缺少生成物：${p}`); continue; }
  const body = readFileSync(join(ROOT, p), 'utf8');
  for (const re of NONDETERMINISTIC) {
    if (re.test(body)) problems.push(`${p} 含不确定字段（命中 ${re}）`);
  }
}

const before = FILES.map(sha);
const run = (args) => execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'pipe' }).toString();

try {
  run(['scripts/gen-prefix-module.mjs']);
  run(['scripts/check-prefix.mjs', '--update']);
  run(['scripts/gen-tokens.mjs']);
  run(['scripts/gen-legal.mjs']);
  run(['scripts/gen-manifest.mjs']);
  run(['scripts/gen-contract.mjs']);
} catch (e) {
  problems.push('生成器执行失败：' + (e.stderr?.toString?.() || e.message));
}

const after = FILES.map(sha);
for (let i = 0; i < FILES.length; i++) {
  if (before[i] !== after[i]) problems.push(`重跑后内容变化：${FILES[i]}`);
}

if (problems.length) {
  console.error('\n✗ check-deterministic: 生成物不确定\n');
  for (const p of problems) console.error('  - ' + p);
  console.error('\n  生成物必须"同样的源 → 同样的字节"，否则 CI 的一致性比对必然失败。');
  console.error('  需要时间戳请放到运行时（/version Edge Function），不要写进生成文件。\n');
  process.exit(1);
}
// 刻意不做 git checkout 回滚：那会把「尚未提交的合法修复」一起退掉，
// 制造出比原问题更难查的假象。生成物本就该被提交，重跑等于修正。
console.log(`✓ check-deterministic: ${FILES.length} 个生成物重跑后字节一致`);
