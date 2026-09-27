#!/usr/bin/env node
/**
 * gen-legal.mjs — 32 篇协议正文 → web/public/legal/<slug>.json
 *
 * 为什么走静态 JSON 而不是打进 JS bundle：32 篇 × 约 2600 字，
 * 进包会直接击穿首屏 180KB 预算（见 docs/分册-网页端.md §10）。
 *
 * 为什么以 legal-data.ts 为单一真源：slug ↔ 编号 ↔ 分组的映射只应该有一份。
 * 生成器直接 import 那份清单（Node 23+ 可剥离类型直接加载 .ts），
 * 任何一篇在清单里有、仓库里却没有源文件 ⇒ 生成器报错退出。
 * 否则那 32 个页面会安静地 404 —— 而协议页 404 是会导致付费路径不合规的。
 *
 * 用法：node scripts/gen-legal.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SRC_DIR = join(ROOT, 'docs/legal');
const OUT_DIR = join(ROOT, 'web/public/legal');

const { LEGAL_DOCS } = await import(new URL('../web/src/features/legal/legal-data.ts', import.meta.url).href);

if (!existsSync(SRC_DIR)) {
  console.error(`✗ 找不到协议源目录 docs/legal`);
  process.exit(1);
}

/** 文件名形如 01-用户服务协议总纲.md —— 用前两位编号与清单对齐 */
const files = readdirSync(SRC_DIR).filter((f) => /^\d{2}-.*\.md$/.test(f) && f !== 'README.md');
const byNo = new Map();
for (const f of files) byNo.set(f.slice(0, 2), f);

const problems = [];
const written = [];

for (const doc of LEGAL_DOCS) {
  const f = byNo.get(doc.no);
  if (!f) { problems.push(`清单里的 ${doc.no} ${doc.title}（slug=${doc.slug}）在 docs/legal 里没有对应源文件`); continue; }

  const raw = readFileSync(join(SRC_DIR, f), 'utf8').replace(/\r\n/g, '\n');

  // 去掉文档头部的元信息块（> 版本：… 那一段）—— 它是写作时的说明，
  // 不是条款本体，渲染出来会让读者以为协议里混了编辑注释。
  const body = raw
    .split('\n')
    .filter((line) => !/^>\s*(版本|待替换占位符|加粗条款)/.test(line))
    .join('\n')
    .trim();

  if (body.length < 500) {
    problems.push(`${doc.no} ${f} 正文仅 ${body.length} 字，疑似截断或过滤过度`);
    continue;
  }

  const payload = {
    no: doc.no,
    slug: doc.slug,
    title: doc.title,
    updated: doc.updated,
    chars: body.length,
    body,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, `${doc.slug}.json`), JSON.stringify(payload, null, 2) + '\n');
  written.push({ no: doc.no, slug: doc.slug, chars: body.length });
}

// 反向检查：仓库里有、清单里没有的协议同样要报出来，
// 否则新增一篇写了半天的协议会永远没人看得到。
const listed = new Set(LEGAL_DOCS.map((d) => d.no));
for (const [no, f] of byNo) {
  if (!listed.has(no)) problems.push(`docs/legal/${f} 不在 legal-data.ts 清单里，页面不会出现`);
}

if (problems.length) {
  console.error('\n✗ gen-legal: 清单与源文件不一致\n');
  for (const p of problems) console.error('  - ' + p);
  console.error('');
  process.exit(1);
}

const total = written.reduce((n, w) => n + w.chars, 0);
console.log(`✓ gen-legal: ${written.length} 篇 → web/public/legal/  合计 ${total} 字`);
const small = written.filter((w) => w.chars < 1500);
if (small.length) {
  console.log(`  ⚠  ${small.length} 篇短于 1500 字：${small.map((s) => s.no + '(' + s.chars + ')').join(' ')}`);
}
