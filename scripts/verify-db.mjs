/**
 * verify-db.mjs — 运行时验收套件（对应 docs/验收清单.md V1 / V2 / V3 部分条目）
 *
 * 为什么必须有：迁移"执行成功"只证明语法对，不证明防护有效。
 * 本脚本用 `set local role authenticated` + JWT claims 真实模拟终端用户身份，
 * 逐条验证越权读取、账本不可变、密文列隔离、并发不超付。
 *
 * 用法：
 *   node --env-file=.env scripts/verify-db.mjs
 *   node --env-file=.env scripts/verify-db.mjs --keep   # 保留测试用户便于排查
 *
 * 测试数据全部以 email 前缀 verify- 标识，默认跑完清理。
 */
import pg from 'pg';

const KEEP = process.argv.includes('--keep');
const DB = {
  host: process.env.SUPABASE_DB_HOST ?? 'aws-0-ap-southeast-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT ?? 5432),
  user: process.env.SUPABASE_DB_USER ?? 'postgres.snubbpxqandqmmwjczsr',
  password: process.env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 25000,
};
if (!DB.password) { console.error('缺少 SUPABASE_DB_PASSWORD'); process.exit(2); }

const admin = new pg.Client(DB);
await admin.connect();

let pass = 0;
const fails = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name + (extra ? ' — ' + extra : '')); console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}
/** 以 authenticated（user=null 时为 anon）身份执行，返回结果或抛出错误 */
async function as(user, sql, params = []) {
  const c = new pg.Client(DB);
  await c.connect();
  try {
    await c.query('begin');
    if (user === null) {
      await c.query(`select set_config('role','anon',true)`);
    } else {
      await c.query(`select set_config('role','authenticated',true)`);
      // 参数化设置，不能用已被 node-postgres 移除的 client.escape()
      await c.query(`select set_config('request.jwt.claims',$1,true)`,
        [JSON.stringify({ sub: user })]);
    }
    const r = await c.query(sql, params);
    await c.query('commit');
    return { rows: r.rows, count: r.rowCount };
  } catch (e) {
    await c.query('rollback').catch(() => {});
    // 没有 5 位 SQLSTATE 的一定不是数据库拒绝，而是本工具自己坏了。
    // 必须炸出来 —— 否则 denied() 会把工具异常当成「权限被拒」而假通过。
    if (typeof e.code !== 'string' || !/^[0-9A-Z]{5}$/.test(e.code)) {
      throw new Error('HARNESS FAILURE (not a DB denial): ' + e.message);
    }
    throw e;
  } finally {
    await c.end().catch(() => {});
  }
}
/**
 * 断言"读不到 / 改不动"。两种正确形态必须分开判：
 *   · SELECT 被 RLS 过滤 ⇒ 返回 0 行且**不报错**（这是正常通过）
 *   · 表级/列级授权缺失或策略拒绝 ⇒ 抛 SQLSTATE 错误
 * 原实现把「没报错」一律当成泄漏，导致 RLS 正常工作时反而报 FAIL。
 */
async function denied(name, user, sql, params) {
  const isSelect = /^\s*select\b/i.test(sql);
  try {
    const r = await as(user, sql, params);
    if (isSelect && r.count === 0) {
      pass++;
      console.log(`  ok   ${name}  (RLS 过滤为 0 行)`);
      return true;
    }
    ok(name, false, isSelect ? `泄漏 ${r.count} 行` : '操作竟然成功');
    return false;
  } catch (e) {
    if (String(e.message).startsWith('HARNESS FAILURE')) throw e;
    pass++;
    console.log(`  ok   ${name}  (${e.code} 拒绝)`);
    return true;
  }
}

// ─── 准备：两个测试用户 ─────────────────────────────────
console.log('\n[准备] 创建测试用户');
const stamp = Date.now();
const mk = async (tag) => {
  const email = `verify-${tag}-${stamp}@example.invalid`;
  const r = await admin.query(
    `insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
             confirmation_token, recovery_token, email_change_token_new, email_change,
             raw_app_meta_data, raw_user_meta_data, is_super_admin, created_at, updated_at)
     values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated','authenticated',
             $1, now(), '','', '','','{}','{}',false, now(), now())
     returning id`, [email]);
  return r.rows[0].id;
};
const A = await mk('a');
const B = await mk('b');
console.log(`  A=${A.slice(0, 8)}…  B=${B.slice(0, 8)}…`);

// 触发器是否自动建齐三张伴生表
const seeded = await admin.query(
  `select (select count(*) from public.profiles where id = any($1::uuid[])) p,
          (select count(*) from public.entitlements where user_id = any($1::uuid[])) e,
          (select count(*) from public.balances where user_id = any($1::uuid[])) b`,
  [[A, B]]);
console.log('\n[注册联动] auth.users 插入后自动建行');
const sc = (v) => Number(v);   // count(*) 未 cast 时 pg 返回字符串
ok('profiles 自动创建 (2/2)', sc(seeded.rows[0].p) === 2, `实际 ${seeded.rows[0].p}`);
ok('entitlements 自动创建 (2/2)', sc(seeded.rows[0].e) === 2, `实际 ${seeded.rows[0].e}`);
ok('balances 自动创建 (2/2)', sc(seeded.rows[0].b) === 2, `实际 ${seeded.rows[0].b}`);

const entA = await admin.query(`select * from public.entitlements where user_id=$1`, [A]);
console.log('\n[Free 档默认值] (16 号专篇 §3.1)');
ok('Free 角色槽位 = 1', Number(entA.rows[0].character_slots) === 1, String(entA.rows[0].character_slots));
ok('Free 携带 = 8192', Number(entA.rows[0].carry_tokens) === 8192, String(entA.rows[0].carry_tokens));
ok('Free 召回 top_k = 4', Number(entA.rows[0].recall_topk) === 4);
ok('Free 群聊上限 = 2', Number(entA.rows[0].group_member_max) === 2);
ok('Free 主动消息 = 0/日', Number(entA.rows[0].proactive_per_day) === 0);

// ─── 官方角色 + 隐藏锁 ─────────────────────────────────
console.log('\n[隐藏锁] character_locks 零读（C8 定案的数据库兜底）');
const charR = await admin.query(
  `insert into public.characters (owner_id, slug, name, tagline, persona_text, example_dialogs, visibility)
   values ($1, 'verify-char-' || substr(md5(random()::text),1,8), '验证角色', 't', 'p', '[]'::jsonb, 'private')
   returning id`, [A]);
const CHAR = charR.rows[0].id;
await admin.query(
  `insert into public.character_locks (character_id, lock_text, static_hash, anti_drift_reply)
   values ($1, 'TOP-SECRET-PROMPT', 'hash', 'pull back')`, [CHAR]);

await denied('普通 SELECT 读不到 lock_text', A, `select lock_text from public.character_locks where character_id=$1`, [CHAR]);
// ⚠ 不能用 `select count(*)`：RLS 过滤后它仍返回**一行**（值为 0），会被误判成泄漏
await denied('作为角色 owner 也读不到任何锁行（最易漏）', A, `select lock_text from public.character_locks`, []);
await denied('读人设版本表', A, `select * from public.character_versions`, []);

const lockDirect = await admin.query(`select lock_text from public.character_locks where character_id=$1`, [CHAR]);
ok('service_role 仍可读写（链路可用）', lockDirect.rows[0].lock_text === 'TOP-SECRET-PROMPT');

// ─── 越权隔离 (V1-1…V1-5) ──────────────────────────────
console.log('\n[越权隔离]');
const sesR = await admin.query(
  `insert into public.sessions (user_id, kind) values ($1,'solo') returning id`, [A]);
const SESS = sesR.rows[0].id;
await admin.query(
  `insert into public.session_members (session_id, character_id, seat) values ($1,$2,1)`, [SESS, CHAR]);
await admin.query(
  `insert into public.messages (session_id,user_id,role,content,character_id) values ($1,$2,'user','私密内容A',$3)`,
  [SESS, A, CHAR]);
await admin.query(
  `insert into public.messages (session_id,user_id,role,content,character_id) values ($1,$2,'user','私密内容B',$3)`,
  [SESS, B, CHAR]);

const own = await as(A, `select content from public.messages where user_id=$1`, [A]);
ok('A 能读自己的消息', own.rows.length === 1 && own.rows[0].content === '私密内容A');
await denied('A 读不到 B 的消息', A, `select * from public.messages where user_id=$1`, [B]);
await denied('A 读不到 B 的会话', A, `select * from public.sessions where user_id=$1`, [B]);
await denied('A 读不到 B 的余额', A, `select * from public.balances where user_id=$1`, [B]);
await denied('A 读不到 B 的账本', A, `select * from public.ledger where user_id=$1`, [B]);

console.log('\n[账本不可变] (V2-1)');
await denied('A 不能 insert ledger', A, `insert into public.ledger (user_id,type,amount) values ($1,'grant',1)`, [A]);
await denied('A 不能 update ledger', A, `update public.ledger set amount=0 where user_id=$1`, [A]);
await denied('A 不能 delete ledger', A, `delete from public.ledger where user_id=$1`, [A]);

// A 必须先有额度，否则 freeze 必然失败、freezeId 为 undefined，
// 后续「按 id 更新 ledger」会匹配 0 行而误判成"更新成功了"
await admin.query(`select public.grant_credit($1, 50, 'purchase', 'verify-order-a', 'seed')`, [A]);
const fz = await admin.query(`select public.freeze_credit($1, 5, gen_random_uuid()) as r`, [A]);
ok('freeze_credit 返回 ok', fz.rows[0].r.ok === true, JSON.stringify(fz.rows[0].r));
const freezeId = fz.rows[0].r.ledger_id;
ok('freeze 返回了 ledger_id', typeof freezeId === 'number' && freezeId > 0, String(freezeId));
await denied('A 不能 update 别人的冻结流水', A, `update public.ledger set amount=99 where id=$1`, [freezeId]);
try {
  await admin.query(`update public.ledger set amount=99 where id=$1`, [freezeId]);
  ok('postgres 自身也不能 update ledger（触发器）', false, '更新成功了');
} catch (e) {
  ok('postgres 自身也不能 update ledger（触发器）', /append-only/.test(e.message), e.message);
}

console.log('\n[BYOK 密文隔离]（拆表 + 零授权）');
const prof = await admin.query(
  `insert into public.byok_profiles (user_id,kind,label,base_url,model,key_mask)
   values ($1,'openai','t','https://api.example.com','m','****abcd') returning id`, [A]);
await admin.query(
  `insert into public.byok_secrets (profile_id,user_id,wrapped_dk,dk_iv,ciphertext,iv)
   values ($1,$2,'w','d','CIPHERTEXT-BLOB','i')`, [prof.rows[0].id, A]);

// 元数据表：只能读自己的行
await denied('A 读不到 B 的 byok_profiles 行', A, `select * from public.byok_profiles where user_id=$1`, [B]);
const ownProf = await as(A, `select key_mask from public.byok_profiles where user_id=$1`, [A]);
ok('A 能读自己的元数据且只有掩码', ownProf.rows.length === 1 && ownProf.rows[0].key_mask === '****abcd');

// ★ 密文表：整表零授权，这才是拆表要解决的问题
await denied('authenticated 完全读不到 byok_secrets（表级零授权）',
  A, `select ciphertext from public.byok_secrets where user_id=$1`, [A]);
await denied('anon 也读不到 byok_secrets',
  null, `select * from public.byok_secrets`, []);

const pub = await as(A, `select * from public.byok_profiles_public where user_id=$1`, [A]);
ok('公开视图可读且不含任何密文字段',
  pub.rows.length === 1 && !('ciphertext' in pub.rows[0]) && !('enc_key' in pub.rows[0])
  && !('wrapped_dk' in pub.rows[0]),
  pub.rows[0] ? Object.keys(pub.rows[0]).join(',') : '无行');

// ─── 计费不变式与并发 (V2-2/3/4) ───────────────────────
console.log('\n[计费不变式与并发]');
await admin.query(`select public.grant_credit($1, 100, 'purchase', 'verify-order-1', 'seed')`, [B]);
let bal = await admin.query(`select * from public.balances where user_id=$1`, [B]);
ok('grant 100 后 usable=100', Number(bal.rows[0].usable) === 100, String(bal.rows[0].usable));

// 结算：冻结 5，实际用 1 → 退 4
const f2 = await admin.query(`select public.freeze_credit($1, 5, gen_random_uuid()) as r`, [B]);
const fid2 = f2.rows[0].r.ledger_id;
const st = await admin.query(`select public.settle_credit($1, 1, null) as r`, [fid2]);
ok('settle 1 后 refunded=4', Number(st.rows[0].r.refunded) === 4, JSON.stringify(st.rows[0].r));
bal = await admin.query(`select * from public.balances where user_id=$1`, [B]);
ok('净消耗恰好为 1', Number(bal.rows[0].spent) === 1 && Number(bal.rows[0].usable) === 99,
  `spent=${bal.rows[0].spent} usable=${bal.rows[0].usable}`);

// 失败全额退回
const f3 = await admin.query(`select public.freeze_credit($1, 7, gen_random_uuid()) as r`, [B]);
const rf = await admin.query(`select public.refund_credit($1, 'model_error') as r`, [f3.rows[0].r.ledger_id]);
ok('失败退回 7', Number(rf.rows[0].r.refunded) === 7, JSON.stringify(rf.rows[0].r));
bal = await admin.query(`select usable, frozen from public.balances where user_id=$1`, [B]);
ok('退回后 frozen 归零', Number(bal.rows[0].frozen) === 0, String(bal.rows[0].frozen));

// 幂等重放
const rid = (await admin.query(`select gen_random_uuid() u`)).rows[0].u;
const r1 = await admin.query(`select public.freeze_credit($1, 3, $2) as r`, [B, rid]);
const r2 = await admin.query(`select public.freeze_credit($1, 3, $2) as r`, [B, rid]);
ok('同 request_id 重放返回同一 ledger_id', r1.rows[0].r.ledger_id === r2.rows[0].r.ledger_id,
  `${r1.rows[0].r.ledger_id} vs ${r2.rows[0].r.ledger_id}`);
ok('重放标记 replay=true', r2.rows[0].r.replay === true);
const dup = await admin.query(`select count(*)::int n from public.ledger where request_id=$1 and type='freeze'`, [rid]);
ok('账本里只有一条 freeze', dup.rows[0].n === 1, String(dup.rows[0].n));

// 并发：余额 1.0，同时打 50 个 freeze(0.1) ⇒ 最多 10 个成功，不得超付
console.log('\n  并发压测：余额 1.0，50 个并发 freeze(0.1)');
const C = await mk('c');
await admin.query(`select public.grant_credit($1, 1, 'purchase', 'verify-order-c', 'seed')`, [C]);
const pool = new pg.Pool({ ...DB, max: 12 });
const jobs = Array.from({ length: 50 }, () =>
  pool.query(`select public.freeze_credit($1, 0.1, gen_random_uuid()) as r`, [C])
    .then((x) => x.rows[0].r.ok === true)
    .catch(() => false));
const results = await Promise.all(jobs);
const success = results.filter(Boolean).length;
const cb = await admin.query(`select usable, frozen, granted, spent from public.balances where user_id=$1`, [C]);
ok('并发不超付（成功数 ≤ 10）', success <= 10, `成功 ${success}`);
ok('占用额恰为 冻结数×0.1', Math.abs(Number(cb.rows[0].frozen) - success * 0.1) < 1e-6,
  `frozen=${cb.rows[0].frozen} 期望 ${(success * 0.1).toFixed(2)}`);
ok('可用 + 占用 = 总额（钱没有凭空消失）',
  Math.abs(Number(cb.rows[0].usable) + Number(cb.rows[0].frozen) - 1) < 1e-6,
  `usable=${cb.rows[0].usable} frozen=${cb.rows[0].frozen}`);
await pool.end();

// 全局不变式
const inv = await admin.query(`select public.audit_ledger_invariants() as r`);
ok('audit_ledger_invariants healthy', inv.rows[0].r.healthy === true, JSON.stringify(inv.rows[0].r));

// ─── 记忆与检索 (V3) ───────────────────────────────────
console.log('\n[记忆与检索]');
const mem = await admin.query(
  `insert into public.memories (user_id, character_id, session_id, kind, text, salience, source_msg_ids)
   values ($1,$2,$3,'fact','用户喜欢吃火锅',0.9, array[]::uuid[]) returning id`, [A, CHAR, SESS]);
const rec = await admin.query(
  `select * from public.recall($1,$2,'火锅',null,4)`, [A, CHAR]);
ok('纯关键词召回（无 embedding）能命中', rec.rows.length >= 1 && /火锅/.test(rec.rows[0].text),
  `${rec.rows.length} 行`);
const recMiss = await admin.query(`select * from public.recall($1,$2,'完全不相关的词xyz',null,4)`, [A, CHAR]);
ok('无关查询不误召回', recMiss.rows.length === 0, `${recMiss.rows.length} 行`);
await denied('A 读不到 B 的记忆', A, `select * from public.memories where user_id=$1`, [B]);

// 删消息 ⇒ 记忆失效
const mid = (await admin.query(
  `insert into public.messages (session_id,user_id,role,content,character_id) values ($1,$2,'user','我爱吃火锅',$3) returning id`,
  [SESS, A, CHAR])).rows[0].id;
await admin.query(`update public.memories set source_msg_ids = array[$2]::uuid[] where id=$1`, [mem.rows[0].id, mid]);
await admin.query(`delete from public.messages where id=$1`, [mid]);
const after = await admin.query(`select invalidated_at from public.memories where id=$1`, [mem.rows[0].id]);
ok('删原始消息后记忆被标失效', after.rows[0].invalidated_at !== null);
const recAfter = await admin.query(`select * from public.recall($1,$2,'火锅',null,4)`, [A, CHAR]);
ok('失效记忆不再被召回', recAfter.rows.length === 0, `${recAfter.rows.length} 行`);

// ─── 群聊上限 (V4-10 相关) ──────────────────────────────
console.log('\n[群聊人数上限]');
const gs = await admin.query(`select public.apply_tier($1,'free')`, [A]);
const g2 = await admin.query(
  `insert into public.characters (owner_id,slug,name,persona_text,example_dialogs)
   values ($1,'verify-g2-'||substr(md5(random()::text),1,8),'二','x','[]'::jsonb) returning id`, [A]);
const g3 = await admin.query(
  `insert into public.characters (owner_id,slug,name,persona_text,example_dialogs)
   values ($1,'verify-g3-'||substr(md5(random()::text),1,8),'三','x','[]'::jsonb) returning id`, [A]);
const gses = (await admin.query(`insert into public.sessions (user_id,kind) values ($1,'group') returning id`, [A])).rows[0].id;
await admin.query(`insert into public.session_members values ($1,$2,1)`, [gses, CHAR]);
await admin.query(`insert into public.session_members values ($1,$2,2)`, [gses, g2.rows[0].id]);
let overOk = false;
try {
  await admin.query(`insert into public.session_members values ($1,$2,3)`, [gses, g3.rows[0].id]);
} catch (e) { overOk = /limit reached/.test(e.message); }
ok('Free 档第 3 个成员被拒（上限 2）', overOk);

// ─── 定价一致性（数据库侧独立复核）─────────────────────
console.log('\n[定价一致性]');
const disc = await admin.query(
  `select a.id, a.price_cny / (m.price_cny * 12) as ratio
     from public.plan_catalog a join public.plan_catalog m
       on m.tier = a.tier and not m.is_annual and not m.is_addon
    where a.is_annual order by a.id`);
for (const r of disc.rows) {
  ok(`${r.id} 年包折扣率落在 90~95%`, Number(r.ratio) >= 0.90 && Number(r.ratio) <= 0.95,
    (Number(r.ratio) * 100).toFixed(1) + '%');
}
const lev = await admin.query(
  `select id, grant_credit / nullif(price_cny,0) as leverage, is_addon
     from public.plan_catalog where not is_annual and price_cny > 0 order by is_addon, id`);
const subMin = Math.min(...lev.rows.filter((r) => !r.is_addon).map((r) => Number(r.leverage)));
const addMax = Math.max(...lev.rows.filter((r) => r.is_addon).map((r) => Number(r.leverage)));
ok('加量包杠杆必须低于会员（否则没人订阅）', addMax < subMin, `加量包最高 ${addMax.toFixed(2)} vs 会员最低 ${subMin.toFixed(2)}`);

// ─── 清理 ───────────────────────────────────────────────
console.log('\n[账本逃生门] 默认锁死，显式开关 + 理由才放行');
// 1) 默认：连 postgres 也删不掉
try {
  await admin.query(`delete from public.ledger where user_id=$1`, [A]);
  ok('默认拒绝 delete ledger', false, '竟然删除成功');
} catch (e) {
  ok('默认拒绝 delete ledger', /append-only/.test(e.message), e.message);
}
// 2) 开了开关但没给理由 ⇒ 仍拒绝
const c2 = new pg.Client(DB);
await c2.connect();
try {
  await c2.query(`select set_config('app.ledger_purge','on',false)`);
  try {
    await c2.query(`delete from public.ledger where user_id=$1`, [A]);
    ok('缺 reason 时仍拒绝', false, '竟然删除成功');
  } catch (e) {
    ok('缺 reason 时仍拒绝', /purge_reason/.test(e.message), e.message);
  }
} finally { await c2.end().catch(() => {}); }

if (!KEEP) {
  console.log('\n[清理] 删除测试用户与数据');
  // profiles 上的外键是 on delete restrict ⇒ 必须先经逃生门清掉 ledger
  const c3 = new pg.Client(DB);
  await c3.connect();
  await c3.query(`select set_config('app.ledger_purge','on',false),
                        set_config('app.purge_reason','verify-db cleanup',false)`);
  await c3.query(`delete from public.ledger where user_id = any($1::uuid[])`, [[A, B, C]]);
  await c3.query(`delete from public.balances where user_id = any($1::uuid[])`, [[A, B, C]]);
  await c3.end();

  await admin.query(`delete from auth.users where id = any($1::uuid[])`, [[A, B, C]]);
  const left = await admin.query(
    `select (select count(*) from public.profiles) p, (select count(*) from public.ledger) l,
            (select count(*) from public.characters where owner_id is not null) c,
            (select count(*) from auth.users) u`);
  ok('清理干净',
    Number(left.rows[0].p) === 0 && Number(left.rows[0].l) === 0
    && Number(left.rows[0].c) === 0 && Number(left.rows[0].u) === 0,
    JSON.stringify(left.rows[0]));
} else {
  console.log('\n[清理] --keep 指定，保留测试数据');
}

await admin.end();

console.log('\n' + '═'.repeat(56));
if (fails.length) {
  console.log(`✗ ${fails.length} 项未通过 / 共 ${pass + fails.length}`);
  for (const f of fails) console.log('   - ' + f);
  process.exit(1);
}
console.log(`✓ 全部通过  ${pass} 项运行时验收`);
