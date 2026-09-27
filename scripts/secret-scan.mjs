#!/usr/bin/env node
/**
 * secret-scan.mjs — 密钥泄漏扫描（CI 硬失败 + pre-commit）
 *
 * 存在理由：尚贤圈仓库根目录有 4 个明文密钥文件（gh token / supabase
 * service_role / pat / access token）。那次靠 .gitignore 挡住了，
 * 但"靠人记得住"不是防线。这个脚本兜底：即使有人 git add -f，CI 也红。
 *
 * 用法：
 *   node scripts/secret-scan.mjs            # 扫全部被 git 跟踪的文件
 *   node scripts/secret-scan.mjs --worktree # 扫工作区（pre-commit 用）
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const WORKTREE = process.argv.includes('--worktree');

const FILENAME_PATTERNS = [
  // 注意 (?!s)：排除 design.tokens.json 这类"设计 token"，
  // 但 access-token.json / gh-token.txt 仍会命中。
  /(^|\/)[^/]*token(?!s)[^/]*\.(txt|json|env|ya?ml)$/i,
  /(^|\/)[^/]*(secret|passwd|password|credential)[^/]*\.(txt|json|env|ya?ml)$/i,
  /(^|\/)[^/]*-key\.txt$/i,
  /(^|\/)[^/]*service[-_]role/i,
  /(^|\/)[^/]*\.keystore$|(^|\/)[^/]*\.jks$/i,
  /(^|\/)keystore\//i,
  /(^|\/)\.env$/i,
  /(^|\/)\.env\.(?!example)/i,
];

/** 内容特征：命中即判定为真实密钥（不是占位符） */
const CONTENT_PATTERNS = [
  { re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/g, why: '疑似 JWT（Supabase key / token 常见形态）' },
  { re: /\bghp_[A-Za-z0-9]{36,}\b/g, why: 'GitHub 个人访问令牌' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, why: 'GitHub 细粒度令牌' },
  { re: /\bghs_[A-Za-z0-9]{36,}\b/g, why: 'GitHub 应用令牌' },
  { re: /\bsbp_[A-Za-z0-9_]{30,}\b/g, why: 'Supabase 个人访问令牌' },
  { re: /\bsk-[A-Za-z0-9]{32,}\b/g, why: '疑似模型 API Key' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, why: 'AWS 访问密钥' },
  { re: /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/g, why: '私钥文件' },
  { re: /\beyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\./g, why: '未签名校验的 JWT 头部' },
];

/** 明确允许的占位符，避免误报 */
const PLACEHOLDER_OK = /(your[-_]|xxx+|<[^>]+>|\*{4,}|REDACTED|placeholder|example|CHANGE_?ME|sk-\*+|sha256|hash)/i;

function listFiles() {
  const worktree = () =>
    execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' })
      .split('\n').filter(Boolean);

  if (WORKTREE) return worktree();

  const tracked = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
  if (tracked.length === 0) {
    // 首次 commit 之前 git ls-files 是空的 —— 若就此报绿，防线等于不存在。
    // 回落到工作区扫描（含未跟踪文件），保证建仓当下一跑就有真检查。
    console.error('  (提示：仓库尚无已跟踪文件，本次按工作区扫描)');
    return worktree();
  }
  return tracked;
}

const problems = [];
let scanned = 0;

let files;
try {
  files = listFiles();
} catch {
  console.error('✗ secret-scan: git 不可用或不在仓库内');
  process.exit(1);
}

for (const f of files) {
  if (/node_modules|dist\/|build\/|\.git\//.test(f)) continue;
  scanned++;

  for (const p of FILENAME_PATTERNS) {
    if (p.test(f)) problems.push(`${f}  文件名疑似密钥文件（${p}）`);
  }

  if (/\.(md|txt|json|js|mjs|cjs|ts|tsx|vue|sql|yml|yaml|toml|html|css|kt|kts)$/i.test(f)) {
    let body = '';
    try { body = readFileSync(f, 'utf8'); } catch { continue; }
    if (body.length > 4_000_000) continue;
    const lines = body.split('\n');
    lines.forEach((line, i) => {
      if (PLACEHOLDER_OK.test(line)) return;
      for (const c of CONTENT_PATTERNS) {
        c.re.lastIndex = 0;
        if (c.re.test(line)) {
          problems.push(`${f}:${i + 1}  ${c.why}`);
        }
      }
    });
  }
}

if (problems.length) {
  console.error(`\n✗ secret-scan: 发现 ${problems.length} 处疑似密钥（已扫描 ${scanned} 个文件）\n`);
  for (const p of [...new Set(problems)]) console.error('  ' + p);
  console.error(`
  处理：
    1. 真密钥 → 立刻从仓库移除，并**作废重发**（进了 git 历史就等于已泄漏，
       单靠后续 commit 删除无效，必须轮换密钥本身）
    2. 误报 → 把该行改成含占位符写法（如 sk-****abcd、<YOUR_TOKEN>），
       或加进本文件 FILENAME_PATTERNS 的白名单逻辑
`);
  process.exit(1);
}
console.log(`✓ secret-scan: ${scanned} 个文件无密钥泄漏迹象`);
