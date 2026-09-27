#!/usr/bin/env node
/**
 * check-deterministic.mjs — 生成物必须确定性
 *
 * 存在理由：CI 里"生成物是否最新"那道检查，在生成器带时间戳时永远不可能绿。
 * 那次就是 gen-manifest 写了 generated_at: new Date() 导致必然失败 ——
 * 检查没错，是生成不确定。这道脚本把"确定性"本身变成可验证的约束。
 *
 * 做法：快照 → 重跑全部生成器 → 比对字节。
 * 用法：node scripts/check-deterministic.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

const GENERATED = [
  'supabase/functions/_shared/prefix.generated.ts',
  'supabase/functions/_shared/prefix.lock.json',
  'web/src/styles/tokens.generated.css',
  'web/src/app/tokens.generated.ts',
  'web/public/manifest.webmanifest',
  'web/public/version.json',
  'web/public/release-notes.json',
  'android/version.properties',
  'android/app/src/main/java/com/echosoul/app/ui/design/DesignTokens.kt',
  'web/src/app/version.ts',
];

/** 生成物里出现这些键就说明不确定性又溜回来了 */
const NONDETERMINISTIC = [/generated_at/, /"generatedAt"\s*:/, /Date\.now\(\)/, /new Date\(\)\.toISOString/];

function sha(p) {
  if (!existsSync(join(ROOT, p))) return '<missing>';
  return createHash('sha256').update(readFileSync(join(ROOT, p))).digest('hex');
}

const problems = [];

for (const p of GENERATED) {
  if (!existsSync(join(ROOT, p))) { problems.push(`缺少生成物：${p}`); continue; }
  const body = readFileSync(join(ROOT, p), 'utf8');
  for (const re of NONDETERMINISTIC) {
    if (re.test(body)) problems.push(`${p} 含不确定字段（命中 ${re}）`);
  }
}

const before = GENERATED.map(sha);
const run = (args) => execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'pipe' }).toString();

try {
  run(['scripts/gen-prefix-module.mjs']);
  run(['scripts/check-prefix.mjs', '--update']);
  run(['scripts/gen-tokens.mjs']);
  run(['scripts/gen-manifest.mjs']);
} catch (e) {
  problems.push('生成器执行失败：' + (e.stderr?.toString?.() || e.message));
}

const after = GENERATED.map(sha);
for (let i = 0; i < GENERATED.length; i++) {
  if (before[i] !== after[i]) {
    problems.push(`重跑后内容变化：${GENERATED[i]}`);
  }
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
console.log(`✓ check-deterministic: ${GENERATED.length} 个生成物重跑后字节一致`);
