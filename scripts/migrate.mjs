/**
 * migrate.mjs — 迁移执行器
 *
 * 为什么不用 supabase CLI：CLI 需要浏览器登录 + 项目 link，
 * 而本环境只有 HTTPS 出口与 pooler 凭据。直连 + 事务包裹更可控，
 * 且能把每个迁移文件末尾的**自检行**原样打印出来（这是迁移是否真的生效的证据）。
 *
 * 特性：
 *   · schema_migrations 记录已应用文件，重复执行自动跳过（幂等）
 *   · 每个文件单独事务，失败即回滚该文件，不影响已成功的
 *   · 打印自检结果；任一布尔列为 false 视为该迁移未达标（默认不阻断，--strict 才阻断）
 *
 * 用法：
 *   node scripts/migrate.mjs --dry      # 只列将要执行什么
 *   node scripts/migrate.mjs            # 执行
 *   node scripts/migrate.mjs --force 003_ledger.sql   # 重跑指定文件
 */
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const ROOT = process.cwd();
const DIR = join(ROOT, 'supabase/migrations');
const DRY = process.argv.includes('--dry');
const STRICT = process.argv.includes('--strict');
const forceIdx = process.argv.indexOf('--force');
const ONLY = forceIdx > -1 ? process.argv[forceIdx + 1] : null;

const cfg = {
  host: process.env.SUPABASE_DB_HOST ?? 'aws-0-ap-southeast-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT ?? 5432),
  user: process.env.SUPABASE_DB_USER ?? 'postgres.snubbpxqandqmmwjczsr',
  password: process.env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 25000,
};
if (!cfg.password) {
  console.error('缺少 SUPABASE_DB_PASSWORD（用 --env-file 或导出环境变量）');
  process.exit(2);
}

const client = new pg.Client(cfg);
await client.connect();
console.log(`已连接 ${cfg.host}:${cfg.port} / ${cfg.database}\n`);

await client.query(`
  create schema if not exists meta;
  create table if not exists meta.schema_migrations (
    filename   text primary key,
    applied_at timestamptz not null default now(),
    checksum   text not null,
    ok         boolean not null default true
  );
`);

const files = (ONLY ? [ONLY] : readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort());

const applied = new Set(
  (await client.query('select filename from meta.schema_migrations')).rows.map((r) => r.filename),
);

let ran = 0, skipped = 0, failed = 0;

for (const f of files) {
  const sql = readFileSync(join(DIR, f), 'utf8');
  const checksum = (await import('node:crypto')).createHash('sha256').update(sql).digest('hex').slice(0, 16);

  if (!ONLY && applied.has(f)) {
    const prev = await client.query('select checksum from meta.schema_migrations where filename=$1', [f]);
    const same = prev.rows[0]?.checksum === checksum;
    console.log(`skip  ${f}  (已应用${same ? '' : ' ⚠ 文件内容已变更，需人工确认是否重跑'})`);
    skipped++;
    continue;
  }

  if (DRY) { console.log(`would run  ${f}  [${basename(DIR)}/${f}]`); ran++; continue; }

  console.log(`── ${f} ${'─'.repeat(Math.max(4, 56 - f.length))}`);
  const t0 = Date.now();
  try {
    await client.query('begin');
    await client.query(sql);
    await client.query('commit');

    // 末尾自检语句的返回结果已被上面执行；单独再跑一次自检段以便读取
    const checks = await runSelfCheck(sql);
    const ms = Date.now() - t0;
    console.log(`   applied in ${ms}ms`);

    let bad = [];
    if (checks === null) {
      console.log('   ⚠ 未找到自检段（约定：末行 `-- ─── 自检`）—— 本次迁移没有运行时证据');
    } else {
      bad = checks.filter((c) => c.value === false || c.name === 'SELF_CHECK_ERRORED');
      console.log(`   自检 ${checks.length - bad.length}/${checks.length} 通过`);
      for (const c of checks) {
        const mark = c.value === true ? '✓' : c.value === false ? '✗' : '·';
        console.log(`     ${mark} ${c.name}${c.value === true || c.value === false ? '' : ' = ' + JSON.stringify(c.value)}`);
      }
    }

    await client.query(
      `insert into meta.schema_migrations (filename, applied_at, checksum, ok)
       values ($1, now(), $2, $3)
       on conflict (filename) do update set applied_at=now(), checksum=$2, ok=$3`,
      [f, checksum, bad.length === 0],
    );
    ran++;
    if (bad.length && STRICT) { console.log(`\n✗ ${f} 自检未达标，--strict 模式中止`); break; }
  } catch (e) {
    await client.query('rollback').catch(() => {});
    console.log(`   FAILED ${e.code || ''} ${e.message}`);
    if (e.position) {
      const line = sql.slice(0, Number(e.position)).split('\n').length;
      console.log(`   位置约在第 ${line} 行：${sql.split('\n')[line - 1]?.trim().slice(0, 90)}`);
    }
    failed++;
    break;                      // 后续迁移依赖前者，失败即停
  }
}

if (!DRY) {
  console.log(`\n执行 ${ran} · 跳过 ${skipped} · 失败 ${failed}`);
  const t = await client.query(
    "select table_name from information_schema.tables where table_schema='public' order by table_name");
  console.log(`public 表现有 ${t.rows.length} 张：${t.rows.map((r) => r.table_name).join(', ')}`);
}

await client.end();
process.exit(failed ? 1 : 0);

/**
 * 从迁移文本里抽出末尾的自检段并执行。
 * 约定：自检段位于最后一行 `-- ─── 自检` 标记之后。
 * 找不到标记时明确返回 null，让调用方报「未检查」而不是假装 0/0 通过。
 */
async function runSelfCheck(sql) {
  const lines = sql.split('\n');
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^--\s*[─-]*\s*自检/.test(lines[i])) { idx = i; break; }
  }
  if (idx === -1) return null;

  const stmt = lines.slice(idx).join('\n').replace(/^\s*--[^\n]*\n/g, '').trim();
  if (!stmt || !/_ok\b/.test(stmt)) return null;

  try {
    const r = await client.query(stmt);
    if (!r.rows.length) return [];
    return Object.entries(r.rows[0]).map(([name, value]) => ({ name, value }));
  } catch (e) {
    return [{ name: 'SELF_CHECK_ERRORED', value: e.message }];
  }
}
