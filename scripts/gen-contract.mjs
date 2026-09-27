#!/usr/bin/env node
/**
 * gen-contract.mjs — 从 shared/contract/api.json 生成两端接口类型（开发任务 0-20）
 *
 * 为什么必须有：同一条协议现在写在三个地方 —— Edge Function 的 Body、
 * web 的 sse.ts、将来的安卓。三处手抄的结果一定是"改了服务端忘了客户端"，
 * 而这种错的表现是运行时字段 undefined，编译期与肉眼都抓不到。
 *
 * 生成物（两份，字段完全同源）：
 *   web/src/types/generated/api.ts
 *   android/app/src/main/java/com/echosoul/app/api/Contract.kt
 *
 * 确定性：不写时间戳、不遍历受文件系统顺序影响的集合、输入顺序即输出顺序。
 * 用法：node scripts/gen-contract.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = JSON.parse(readFileSync(join(ROOT, 'shared', 'contract', 'api.json'), 'utf8'));

const BANNER = '// 由 scripts/gen-contract.mjs 从 shared/contract/api.json 生成，禁止手改。\n'
  + '// 要改协议，改那份 JSON，然后 npm run gen:contract。\n';

// ── TypeScript ───────────────────────────────────────────
const TS_SCALAR = { uuid: 'string', string: 'string', int: 'number', number: 'number', boolean: 'boolean' };

function tsType(t) {
  if (TS_SCALAR[t]) return TS_SCALAR[t];
  if (t === 'string[]') return 'string[]';
  return t;   // 枚举名或对象名，两边同名
}

function emitTs() {
  const lines = [BANNER, '/** 跨端接口的类型单一源。snake_case 是线上协议原样，不是疏忽。 */', ''];

  for (const [name, values] of Object.entries(src.enums)) {
    lines.push(`export type ${name} = ${values.map((v) => JSON.stringify(v)).join(' | ')};`);
  }
  lines.push('');

  for (const [name, fields] of Object.entries(src.objects)) {
    lines.push(`export interface ${name} {`);
    for (const f of fields) {
      const opt = f.optional ? '?' : '';
      const nul = f.nullable ? ' | null' : '';
      lines.push(`  ${f.name}${opt}: ${tsType(f.type)}${nul};`);
    }
    lines.push('}', '');
  }

  // 流事件的判别联合：TS 侧靠它保证 switch 分支不漏
  lines.push('export type ChatEvent =',
    "| { type: 'meta'; data: ChatMeta }",
    "| { type: 'delta'; text: string }",
    '| { type: \'done\'; data: ChatDone }',
    '| { type: \'error\'; data: ChatError };', '');
  return lines.join('\n');
}

// ── Kotlin ───────────────────────────────────────────────
const KT_SCALAR = { uuid: 'String', string: 'String', int: 'Int', number: 'Double', boolean: 'Boolean' };

function ktType(t) {
  if (KT_SCALAR[t]) return KT_SCALAR[t];
  if (t === 'string[]') return 'List<String>';
  return t;
}

const ktIdent = (s) => s.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();

function emitKt() {
  const lines = [
    'package com.echosoul.app.api',
    '',
    '// 由 scripts/gen-contract.mjs 从 shared/contract/api.json 生成，禁止手改。',
    '// 字段名保持线上协议的 snake_case：一旦安卓侧改成驼峰，抓包、服务端与客户端就对不上话。',
    '',
  ];

  for (const [name, values] of Object.entries(src.enums)) {
    lines.push(`enum class ${name}(val wire: String) {`);
    for (const v of values) lines.push(`    ${ktIdent(v)}(${JSON.stringify(v)}),`);
    lines.push('}', '');
  }

  for (const [name, fields] of Object.entries(src.objects)) {
    lines.push(`data class ${name}(`);
    fields.forEach((f, i) => {
      const comma = i === fields.length - 1 ? '' : ',';
      if (f.optional) {
        lines.push(`    val ${f.name}: ${ktType(f.type)}? = null${comma}`);
      } else {
        lines.push(`    val ${f.name}: ${ktType(f.type)}${comma}`);
      }
    });
    lines.push(')', '');
  }
  return lines.join('\n');
}

const writes = [
  ['web/src/types/generated/api.ts', emitTs()],
  ['android/app/src/main/java/com/echosoul/app/api/Contract.kt', emitKt()],
];

for (const [rel, body] of writes) {
  const abs = join(ROOT, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body.endsWith('\n') ? body : body + '\n');
  console.log(`  ✓ ${rel}`);
}
