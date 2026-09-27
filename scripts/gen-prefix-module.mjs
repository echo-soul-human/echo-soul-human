#!/usr/bin/env node
/**
 * gen-prefix-module.mjs — 把 _shared/prefix/*.md 编译成 Edge Function 可 import 的 TS 模块
 *
 * 为什么生成而不是运行时读文件：
 *   Supabase Edge Function 里读相对路径文件不可靠（取决于部署打包方式），
 *   而静态前缀必须**逐字节稳定**。生成成模块 = 前缀内容随代码一起版本化，
 *   diff 可见、hash 可比、CI 可拦。
 *
 * 用法：node scripts/gen-prefix-module.mjs
 * 生成：supabase/functions/_shared/prefix.generated.ts
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = process.cwd();
const DIR = join(ROOT, 'supabase/functions/_shared/prefix');
const OUT = join(ROOT, 'supabase/functions/_shared/prefix.generated.ts');

if (!existsSync(DIR)) {
  console.error(`✗ 找不到前缀目录：${relative(ROOT, DIR)}`);
  process.exit(1);
}

/** 安全嵌入模板字面量：转义反斜杠、反引号与 ${ */
function lit(text) {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

const platform = readFileSync(join(DIR, 'platform-lock.md'), 'utf8').replace(/\r\n/g, '\n');
const roleTpl = readFileSync(join(DIR, 'role-lock.tpl.md'), 'utf8')
  .replace(/\r\n/g, '\n')
  // 模板文件里的 HTML 注释是给写模板的人看的说明，不能进 prompt
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/^\n+/, '')
  .replace(/\s+$/, '\n');

const combined = platform + '\n\n' + roleTpl;
const sha256 = createHash('sha256').update(combined).digest('hex');

const placeholders = [...new Set([...roleTpl.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]))].sort();

const body = `/**
 * 由 scripts/gen-prefix-module.mjs 生成 —— 禁止手工编辑。
 * 改前缀请改 supabase/functions/_shared/prefix/*.md 然后重跑生成器。
 *
 * ★ 本文件内容会进入 DeepSeek 的前缀缓存匹配。
 *   改动它 = 击穿全量缓存 = 单轮成本涨约 3.2 倍（不报错，只亏钱）。
 *   改完必须：node scripts/check-prefix.mjs --update
 *            并在 PR 描述写明预期成本影响，发布后盯命中率看板（目标 ≥90%）。
 *
 * sha256(platform + roleTpl) = ${sha256}
 */

export const PLATFORM_LOCK = \`${lit(platform.trim())}\`;

export const ROLE_LOCK_TPL = \`${lit(roleTpl.trim())}\`;

export const PREFIX_HASH = '${sha256}';

/** 模板里出现的占位符清单，供运行时校验与文档对照 */
export const PREFIX_PLACEHOLDERS = ${JSON.stringify(placeholders)} as const;
`;

writeFileSync(OUT, body);

const files = readdirSync(DIR).sort();
console.log(`✓ gen-prefix-module: ${files.length} 个前缀文件 → prefix.generated.ts`);
console.log(`  sha256 ${sha256.slice(0, 16)}…`);
console.log(`  占位符 ${placeholders.join(', ')}`);
console.log(`  PLATFORM_LOCK ${platform.trim().length} 字 · ROLE_LOCK_TPL ${roleTpl.trim().length} 字`);

// 前向校验：模板里的占位符必须都在 prefix.ts 的白名单里
const ALLOWED = ['CHAR_NAME','TAGLINE','PERSONA','EXAMPLE_DIALOGS','BEHAVIOR_NOTES','STAGE_FORMS','ANTI_DRIFT_REPLY','CHARACTER_BOUNDARIES'];
const unknown = placeholders.filter((p) => !ALLOWED.includes(p));
if (unknown.length) {
  console.error(`\n✗ 模板含白名单外的占位符：${unknown.join(', ')}`);
  console.error('  新增占位符会击穿缓存，需同步 prefix.ts 的 ALLOWED_PLACEHOLDERS 并走 prefix-break 评审。\n');
  process.exit(1);
}
