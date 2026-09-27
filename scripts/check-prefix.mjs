#!/usr/bin/env node
/**
 * check-prefix.mjs — 静态前缀保护（CI 硬失败）
 *
 * 存在理由：DeepSeek 的上下文缓存按「前缀完全一致」命中。只要静态前缀里
 * 混进一个时间戳，命中率归零，单轮成本从 ¥0.0035 涨回 ¥0.0112（贵 3.2 倍），
 * 而且**不会报错，只会悄悄亏钱**。所以这道防线必须是机器判的。
 *
 * 两件事：
 *   A. 扫描 chat 链路源码：前缀作用域内禁止出现动态值
 *   B. 给前缀文件算 hash 并与锁文件比对 —— 内容变了必须显式重新生成锁文件，
 *      等价于强制走一次「prefix-break」评审 + 命中率基线复测
 *
 * 用法：
 *   node scripts/check-prefix.mjs            # 校验
 *   node scripts/check-prefix.mjs --update   # 确认要改前缀时，更新锁文件
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = process.cwd();
const PREFIX_DIR = 'supabase/functions/_shared/prefix';
const LOCK = 'supabase/functions/_shared/prefix.lock.json';
const CHAT_SRC = ['supabase/functions/chat', 'supabase/functions/_shared'];
const UPDATE = process.argv.includes('--update');

/** 出现在前缀作用域里就等于击穿缓存 */
const FORBIDDEN_IN_PREFIX = [
  { re: /Date\.now\s*\(/g, why: 'Date.now()' },
  { re: /new\s+Date\s*\(/g, why: 'new Date()' },
  { re: /toISOString\s*\(/g, why: 'toISOString()' },
  { re: /\buser\.(nickname|handle|id|email)\b/g, why: '用户身份字段' },
  { re: /\b(balance|credit|remaining|quota)\s*\./gi, why: '余额/额度字段' },
  { re: /Math\.random\s*\(/g, why: 'Math.random()' },
  { re: /\b(nonce|trace_?id|request_?id)\b/g, why: '请求级随机/追踪标识' },
];

/** 标识符里出现这些词 → 认为它所在的作用域是「前缀拼装区」 */
const PREFIX_SCOPE_NAME = /(platformLock|roleLock|staticPrefix|buildPrefix|buildStaticPrefix|prefixA|prefixB|PLATFORM_LOCK|ROLE_LOCK|systemPrompt)/i;

const errors = [];
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|js|mts|mjs)$/.test(p)) yield p;
  }
}

/** 去掉行注释与块注释内容，保留行结构 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

/**
 * 找出「前缀作用域」：从声明了 PREFIX_SCOPE_NAME 的行开始，
 * 到该行的花括号/圆括号配平为止。作用域内的行才做禁用检查。
 * 这样既不会漏（拼装往往跨多行），也不会误伤无关代码。
 */
function prefixScopes(lines) {
  const scopes = [];
  const limit = lines.length;
  for (let i = 0; i < limit; i++) {
    if (!PREFIX_SCOPE_NAME.test(lines[i])) continue;

    // 从声明行起按括号配平向后扩展，最多 60 行
    let depth = 0;
    let seenOpen = false;
    let end = i;
    for (let j = i; j < Math.min(limit, i + 60); j++) {
      for (const ch of lines[j]) {
        if (ch === '{' || ch === '(' || ch === '[') { depth++; seenOpen = true; }
        else if (ch === '}' || ch === ')' || ch === ']') depth--;
      }
      end = j;
      if (seenOpen && depth <= 0) break;
    }
    // 无括号的简单声明：作用域 = 声明行 + 后 3 行
    if (!seenOpen) end = Math.min(limit - 1, i + 3);
    scopes.push([i, end]);
  }
  return scopes;
}

for (const base of CHAT_SRC) {
  for (const file of walk(join(ROOT, base))) {
    const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
    // 作用域区间会重叠（外层拼装函数 + 内层各前缀变量），用 Set 去重
    const hits = new Set();
    for (const [from, to] of prefixScopes(lines)) {
      for (let i = from; i <= to; i++) {
        for (const f of FORBIDDEN_IN_PREFIX) {
          f.re.lastIndex = 0;
          if (f.re.test(lines[i])) {
            hits.add(`${i + 1}|${f.why}`);
          }
        }
      }
    }
    for (const h of [...hits].sort((a, b) => Number(a.split('|')[0]) - Number(b.split('|')[0]))) {
      const [ln, why] = h.split('|');
      errors.push(`${rel(file)}:${ln}  前缀作用域内出现 ${why} —— 会击穿提示词缓存，单轮成本涨约 3.2 倍。把动态信息移到消息尾部。`);
    }
  }
}

// ── B. 前缀文件 hash 锁 ────────────────────────────────────────
function prefixFiles() {
  const dir = join(ROOT, PREFIX_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /\.(md|txt)$/.test(f)).sort();
}

function computeHashes() {
  const out = {};
  for (const f of prefixFiles()) {
    const buf = readFileSync(join(ROOT, PREFIX_DIR, f));
    out[f] = {
      sha256: createHash('sha256').update(buf).digest('hex'),
      bytes: buf.length,
      lines: buf.toString('utf8').split('\n').length,
    };
  }
  return out;
}

const current = computeHashes();

if (UPDATE) {
  writeFileSync(join(ROOT, LOCK), JSON.stringify({ generatedBy: 'check-prefix.mjs --update', files: current }, null, 2) + '\n');
  console.log(`✓ check-prefix: 锁文件已更新（${Object.keys(current).length} 个前缀文件）`);
  console.log('  ⚠️ 你刚刚改变了静态前缀。发布后必须盯「缓存命中率看板」，目标 ≥ 90%。');
  console.log('  ⚠️ 并在 PR 描述里写明预期成本影响（见 docs/分册-模型与计费.md §2.3）。');
  process.exit(errors.length ? 1 : 0);
}

if (!existsSync(join(ROOT, LOCK))) {
  if (Object.keys(current).length) {
    errors.push(`缺少 ${rel(join(ROOT, LOCK))}。先跑：node scripts/check-prefix.mjs --update`);
  }
} else {
  const lock = JSON.parse(readFileSync(join(ROOT, LOCK), 'utf8')).files || {};
  for (const [f, info] of Object.entries(current)) {
    if (!lock[f]) errors.push(`前缀文件 ${f} 未登记在锁文件中（新增内容会击穿缓存）`);
    else if (lock[f].sha256 !== info.sha256) {
      errors.push(`前缀文件 ${f} 内容已变化（sha256 不一致）。若确属必要：node scripts/check-prefix.mjs --update，并复测命中率基线。`);
    }
  }
  for (const f of Object.keys(lock)) {
    if (!current[f]) errors.push(`前缀文件 ${f} 被删除。删除同样会击穿缓存，需同等评审。`);
  }
}

if (errors.length) {
  console.error(`\n✗ check-prefix: ${errors.length} 个问题\n`);
  for (const e of errors) console.error('  ' + e);
  console.error('');
  process.exit(1);
}
console.log(`✓ check-prefix: 静态前缀未被污染（${Object.keys(current).length} 个前缀文件 hash 一致）`);
