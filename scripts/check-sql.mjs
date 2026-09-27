#!/usr/bin/env node
/**
 * check-sql.mjs — 迁移 SQL 静态检查（CI 硬失败）
 *
 * 存在理由：尚贤圈曾连续两轮"假修复"——用 JS 的 String.replace 生成 SQL 时，
 * 替换串里的 `$$` 被当作特殊序列转义成 `$`，导致函数闭合端 `end $$;` 被截成 `end $;`，
 * SQL 静默损坏，表面跑通、实际函数没建。这个脚本就是那道防线。
 *
 * 检查项：
 *   1. 美元引用标签配平（含 $fn$ 这类具名标签，支持不同标签嵌套）
 *   2. 孤立单美元截断特征（`end $;` / `$ ;` / 语句尾单 $）
 *   3. create function 必须有 language 或 returns
 *   4. security definer 必须显式 set search_path（否则是提权漏洞）
 *   5. 每个迁移文件末尾必须有自检查询（_ok 列）
 *
 * 用法：node scripts/check-sql.mjs [--verbose]
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const DIRS = ['supabase/migrations', 'supabase/functions', 'supabase/patches'];
const verbose = process.argv.includes('--verbose');

const errors = [];
const warn = (file, line, msg) => errors.push({ file, line, msg });

function* sqlFiles() {
  for (const d of DIRS) {
    const abs = join(ROOT, d);
    if (!existsSync(abs)) continue;
    const stack = [abs];
    while (stack.length) {
      const cur = stack.pop();
      for (const e of readdirSync(cur, { withFileTypes: true })) {
        const p = join(cur, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.name.endsWith('.sql')) yield p;
      }
    }
  }
}

/** 去掉注释与字符串字面量，避免误报（保留行号） */
function stripNoise(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let mode = null; // 'line-comment' | 'block-comment' | 'string'
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (mode === 'line-comment') {
      if (c === '\n') { mode = null; out += c; } else out += ' ';
      i++; continue;
    }
    if (mode === 'block-comment') {
      if (c === '*' && c2 === '/') { mode = null; out += '  '; i += 2; continue; }
      out += c === '\n' ? c : ' '; i++; continue;
    }
    if (mode === 'string') {
      if (c === "'" && c2 === "'") { out += '  '; i += 2; continue; } // 转义单引号
      if (c === "'") mode = null;
      out += c === '\n' ? c : ' '; i++; continue;
    }
    if (c === '-' && c2 === '-') { mode = 'line-comment'; out += '  '; i += 2; continue; }
    if (c === '/' && c2 === '*') { mode = 'block-comment'; out += '  '; i += 2; continue; }
    if (c === "'") { mode = 'string'; out += ' '; i++; continue; }
    out += c;
    i++;
  }
  return out;
}

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

function checkDollarQuotes(file, clean) {
  // 1) 具名/匿名美元标签配平（栈：同名闭合才弹出，允许不同标签嵌套）
  const stack = [];
  const re = /\$([A-Za-z_][A-Za-z_0-9]*)\$|\$\$/g;
  let m;
  while ((m = re.exec(clean))) {
    const tag = m[0];
    if (stack.length && stack[stack.length - 1].tag === tag) stack.pop();
    else stack.push({ tag, at: m.index });
  }
  if (stack.length) {
    for (const s of stack) {
      warn(file, lineOf(clean, s.at), `美元引用未配平：${s.tag}`);
    }
  }

  // 2) 截断特征：孤立的 `$;` / `end $`
  //    先把所有合法的 $tag$ 对（含匿名 $$）抹成等长空格，剩下的才是真孤立。
  //    不做这一步，`$do$;` 这类合法闭合会被误判为截断。
  const stripped = clean.replace(/\$[A-Za-z_0-9]*\$/g, (mm) => ' '.repeat(mm.length));

  const orphan = /\$\s*;/g;
  let m2;
  while ((m2 = orphan.exec(stripped))) {
    warn(file, lineOf(clean, m2.index), '疑似 $ 被截断（出现孤立 `$;`）。检查是否本应为 `$$;`');
  }
  const danglingEnd = /\bend\s+\$\s*$/gim;
  while ((m2 = danglingEnd.exec(stripped))) {
    warn(file, lineOf(clean, m2.index), '疑似 `end $$` 被截成 `end $`');
  }
}

function checkFunctions(file, clean) {
  const re = /create\s+or\s+replace\s+function\s+([^\s(]+)/gis;
  let m;
  while ((m = re.exec(clean))) {
    const name = m[1];
    const start = m.index;
    // 取到下一个 create 之前，作为该函数体近似范围
    const next = clean.slice(start + m[0].length).search(/create\s+or\s+replace\s+(function|table|view)/i);
    const body = clean.slice(start, next < 0 ? clean.length : start + m[0].length + next);
    const line = lineOf(clean, start);

    if (!/\blanguage\b/i.test(body) && !/\breturns\b/i.test(body)) {
      warn(file, line, `函数 ${name} 缺少 LANGUAGE 或 RETURNS 子句（可能被截断）`);
    }
    if (/security\s+definer/i.test(body) && !/set\s+search_path/i.test(body)) {
      warn(file, line, `函数 ${name} 是 SECURITY DEFINER 但未 SET search_path —— 提权风险`);
    }
  }
}

function checkSelfTest(file, raw) {
  // 迁移文件（NNN_*.sql）要求末尾有自检查询
  if (!/^\d{3}_/.test(file.split(/[\\/]/).pop())) return;
  if (!/_ok\b/.test(raw)) {
    warn(file, 1, '迁移文件缺少自检查询（应返回若干 `*_ok` 列，见 docs/分册-后端与数据库.md §2 规则 3）');
  }
}

let count = 0;
for (const abs of sqlFiles()) {
  count++;
  const rel = relative(ROOT, abs).replace(/\\/g, '/');
  const raw = readFileSync(abs, 'utf8');
  const clean = stripNoise(raw);
  checkDollarQuotes(rel, clean);
  checkFunctions(rel, clean);
  checkSelfTest(rel, raw);
  if (verbose) console.log(`  ✓ ${rel}`);
}

if (errors.length) {
  console.error(`\n✗ check-sql: ${errors.length} 个问题（已扫描 ${count} 个 .sql）\n`);
  for (const e of errors) console.error(`  ${e.file}:${e.line}  ${e.msg}`);
  console.error('\n提示：若这些 SQL 是由 JS 模板生成的，检查是否用了字符串替换——');
  console.error('      String.replace 的第二个参数里 `$$` 会被转义成 `$`，必须改用函数式替换：');
  console.error('      sql.replace(re, () => body)\n');
  process.exit(1);
}
console.log(`✓ check-sql: ${count} 个 .sql 全部通过`);
