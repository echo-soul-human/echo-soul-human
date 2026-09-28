/**
 * verify-rpc.mjs — 真调用每一个业务 RPC
 *
 * 为什么单独有这一个文件：Postgres 创建 plpgsql 函数时**不校验函数体**，
 * 引用不存在的函数/列、写错的语法都能创建成功。008 的迁移自检 4/4 全绿，
 * 但真调时暴露出 6 个只在运行时才炸的缺陷（load_tier_flags 不存在、
 * visibility_public 列不存在、plpgsql 里写 |> 管道、extract(weekday from timestamptz)、
 * and/or 优先级把 lite 频率限制架空、首次好感度跃迁被"一天一次"卡死）。
 * "函数存在" ≠ "函数能用"。
 *
 * 用法：node --env-file=.env scripts/verify-rpc.mjs [--keep]
 */
import pg from 'pg';

const KEEP = process.argv.includes('--keep');
const DB = {
  host: process.env.SUPABASE_DB_HOST || 'aws-0-ap-southeast-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 5432),
  user: process.env.SUPABASE_DB_USER || 'postgres.snubbpxqandqmmwjczsr',
  password: process.env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 25000,
};
if (!DB.password) { console.error('缺少 SUPABASE_DB_PASSWORD'); process.exit(2); }

// ★ 用共享连接池，不要每次 withRole 都新开一条 Client。
//   一轮跑上百次 withRole，session pooler 的连接数会被打满，
//   症状是脚本静默卡住（前面实测卡死过一次），而且报错信息毫无指向性。
//   admin 也从池里取，保证全脚本只有这一个连接来源。
const pool = new pg.Pool({ ...DB, max: 4, idleTimeoutMillis: 15000 });
const admin = await pool.connect();

let pass = 0;
const fails = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else {
    fails.push(name + (extra ? ' — ' + extra : ''));
    console.log('  FAIL ' + name + (extra ? ' — ' + extra : ''));
  }
}
const j = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };

/** 连接级瞬时错误：只有这类才重试 */
function isTransient(e) {
  const m = String(e && e.message || '');
  return /Connection terminated|ECONNRESET|ETIMEDOUT|server closed the connection|socket hang up/i.test(m)
    || (e && e.code === 'ECONNRESET');
}

/** 以指定身份开一次连接并设置 JWT。'service' = 不切角色（跑被 revoke 的内部函数） */
async function withRole(asUid, fn, attempt = 1) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    if (asUid === 'anon') {
      await c.query("select set_config('role','anon',true)");
    } else if (asUid !== 'service') {
      await c.query("select set_config('role','authenticated',true)");
      await c.query('select set_config($1,$2,true)',
        ['request.jwt.claims', JSON.stringify({ sub: asUid, role: 'authenticated' })]);
    }
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    // 只对连接抖动重试；带 5 位 SQLSTATE 的是真实业务/权限错误，重试会掩盖问题
    if (attempt < 3 && isTransient(e) && !/^[0-9A-Z]{5}$/.test(String(e.code || ''))) {
      c.release();
      await new Promise((r) => setTimeout(r, 400 * attempt));
      return withRole(asUid, fn, attempt + 1);
    }
    throw e;
  } finally {
    c.release();
  }
}

const ph = (n) => Array.from({ length: n }, (_, i) => '$' + (i + 1)).join(',');

/** 标量 RPC */
async function tryRpc(fn, args, asUid) {
  try {
    const r = await withRole(asUid, (c) => c.query('select public.' + fn + '(' + ph(args.length) + ') as v', args));
    return { ok: true, v: r.rows[0].v };
  } catch (e) { return { ok: false, err: e.message, code: e.code }; }
}

/** 直接读表（不是函数）。表与函数的调用形态不同，混用会报 does not exist */
async function tryTable(name, asUid, where = '', params = []) {
  try {
    const v = await withRole(asUid, (c) => c.query(
      'select coalesce(jsonb_agg(to_jsonb(t)), \'[]\'::jsonb) as v from public.' +
      name + ' t ' + (where ? 'where ' + where : ''), params));
    return { ok: true, v: v.rows[0].v };
  } catch (e) { return { ok: false, err: e.message, code: e.code }; }
}

/** 集合返回 RPC：聚成 jsonb，否则 node-pg 会把复合行给成 "(a,b)" 文本 */
async function tryRpcSet(fn, args, asUid) {
  try {
    const r = await withRole(asUid, (c) => c.query(
      "select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) as v from public." + fn + '(' + ph(args.length) + ') t', args));
    return { ok: true, v: r.rows[0].v };
  } catch (e) { return { ok: false, err: e.message, code: e.code }; }
}

// ─── preflight：清扫历史孤儿 ────────────────────────────
// chat_turns 的 user_id 刻意没有外键（成本事实表要能独立于账号留存），
// 代价是删用户不会带走它。历史运行留下的无主行会让"成功轮次"之类的
// 统计断言失真（已实际误报一次）。所以清扫必须在**造数据之前**做，
// 只在末尾做的话，"发现污染的那一次"仍然会红，得跑第二次才绿。
{
  const swept = await admin.query(
    'delete from public.chat_turns t where not exists ' +
    '(select 1 from public.profiles p where p.id = t.user_id)');
  if (swept.rowCount > 0) {
    console.log(`\n[preflight] 清扫无主成本行 ${swept.rowCount} 条`);
  }
  const orphanUsers = await admin.query(
    "select count(*)::int n from auth.users where email like 'rpc-%'");
  if (Number(orphanUsers.rows[0].n) > 0) {
    console.log(`[preflight] 发现历史遗留测试用户 ${orphanUsers.rows[0].n} 个（将在末尾一并清理）`);
  }
}

// ─── 造数据 ────────────────────────────────────────────
const stamp = Date.now();
async function mkUser(tag, birth) {
  const email = 'rpc-' + tag + '-' + stamp + '@example.invalid';
  const r = await admin.query(
    'insert into auth.users (instance_id,id,aud,role,email,email_confirmed_at,' +
    'confirmation_token,recovery_token,email_change_token_new,email_change,' +
    'raw_app_meta_data,raw_user_meta_data,is_super_admin,created_at,updated_at) ' +
    "values ('00000000-0000-0000-0000-000000000000',gen_random_uuid(),'authenticated','authenticated'," +
    '$1,now(),$2,$3,$4,$5,$6,$7,false,now(),now()) returning id',
    [email, '', '', '', '', '{}', '{}']);
  const id = r.rows[0].id;
  if (birth) await admin.query('update public.profiles set birth_declared=$2 where id=$1', [id, birth]);
  return id;
}

console.log('\n[准备]');
const U = await mkUser('u');
const V = await mkUser('v');
const MINOR = await mkUser('minor', '2012-01-01');
console.log('  用户', U.slice(0, 8), V.slice(0, 8), '未成年', MINOR.slice(0, 8));

const off = await admin.query(
  'insert into public.characters (owner_id,name,tagline,persona_text,greeting,example_dialogs,visibility,review_status) ' +
  "values (null,'官方·测试','tag','persona','你好呀','[]'::jsonb,'public','approved') returning id");
const OFFICIAL = off.rows[0].id;

// ─── 角色与权益 ────────────────────────────────────────
console.log('\n[角色与权益]');
const cc = await tryRpc('create_character', ['小明', '一句话简介', '话不多但记性好', '回来了？', '[]'], U);
t('create_character 可调', cc.ok, cc.err);
const CHAR = cc.ok ? cc.v : null;

const cc2 = await tryRpc('create_character', ['第二个', '', '', '', '[]'], U);
t('Free 档第 2 个角色被拒（槽位=1）', !cc2.ok && /SLOT_LIMIT/.test(cc2.err || ''), cc2.ok ? '竟然成功' : cc2.err);

const ccBlank = await tryRpc('create_character', ['   ', '', '', '', '[]'], U);
t('空名字被拒', !ccBlank.ok && /NAME_REQUIRED/.test(ccBlank.err || ''), ccBlank.ok ? '竟然成功' : ccBlank.err);

// jsonb 参数必须显式 stringify：node-pg 会把 JS 数组当成 Postgres 数组字面量
// 发出去（"{...}"），传给 jsonb 就报 invalid input syntax for type json。
const uc = await tryRpc('update_character',
  [CHAR, null, '改了简介', '新的人设正文', null, JSON.stringify([{ user: 'a', role: 'b' }]),
   null, null, null, null], U);
t('update_character 可调', uc.ok, uc.err);

const ver = await admin.query('select published_version from public.characters where id=$1', [CHAR]);
t('改人设产生新版本号', Number(ver.rows[0].published_version) >= 2, String(ver.rows[0].published_version));

const lk = await admin.query('select lock_text from public.character_locks where character_id=$1', [CHAR]);
t('隐藏锁随人设同步更新', /新的人设正文/.test((lk.rows[0] || {}).lock_text || ''), (lk.rows[0] || {}).lock_text);

const ucNo = await tryRpc('update_character', [CHAR, '劫持', null, null, null, null, null, null, null, null], V);
t('非 owner 改不了别人的角色', !ucNo.ok && /NOT_OWNER/.test(ucNo.err || ''), ucNo.ok ? '竟然成功' : ucNo.err);

const pub = await tryRpc('publish_character', [CHAR, 'public'], U);
t('publish_character 不引用不存在的函数', pub.ok, pub.err);

// ─── 会话 ──────────────────────────────────────────────
console.log('\n[会话]');
const os = await tryRpc('open_session', [OFFICIAL], U);
t('open_session 可调', os.ok, os.err);
const SID = os.ok ? os.v : null;

const os2 = await tryRpc('open_session', [OFFICIAL], U);
t('重复 open 复用同一会话', os2.ok && os2.v === SID, os2.v + ' vs ' + SID);

const gr = await admin.query(
  "select count(*)::int n from public.messages where session_id=$1 and role='assistant' and origin='imported'", [SID]);
t('开场白作为真实消息落库', Number(gr.rows[0].n) === 1, String(gr.rows[0].n));

const osBad = await tryRpc('open_session', ['00000000-0000-0000-0000-000000000000'], U);
t('open 不存在的角色被拒', !osBad.ok && /CHARACTER_NOT_AVAILABLE/.test(osBad.err || ''), osBad.ok ? '竟然成功' : osBad.err);

const ls = await tryRpcSet('list_sessions', [], U);
t('list_sessions 可调', ls.ok, ls.err);
t('list_sessions 返回会话', Array.isArray(ls.v) && ls.v.length >= 1, j(ls.v || ls.err));
t('list_sessions 带角色名数组',
  Array.isArray(ls.v) && Array.isArray((ls.v[0] || {}).character_names) && ls.v[0].character_names.length >= 1,
  j((ls.v || [])[0] && ls.v[0].character_names));
t('list_sessions 带 preview 摘要',
  Array.isArray(ls.v) && typeof (ls.v[0] || {}).preview === 'string' && ls.v[0].preview.length > 0,
  j((ls.v || [])[0] && ls.v[0].preview));

const pm = await tryRpcSet('page_messages', [SID, null, 10], U);
t('page_messages 可调', pm.ok, pm.err);
const pmOther = await tryRpcSet('page_messages', [SID, null, 10], V);
t('别人的会话取不到消息', !pmOther.ok || (Array.isArray(pmOther.v) && pmOther.v.length === 0),
  pmOther.ok ? '返回 ' + pmOther.v.length + ' 行' : pmOther.err);

const ps = await tryRpc('patch_session', [SID, '改名了', null, true, null], U);
t('patch_session 可调', ps.ok, ps.err);
const psc = await admin.query('select title, pinned_at is not null as pinned from public.sessions where id=$1', [SID]);
t('改名与置顶真的生效', psc.rows[0].title === '改名了' && psc.rows[0].pinned === true, j(psc.rows[0]));
const psOther = await tryRpc('patch_session', [SID, '劫持', null, null, null], V);
t('非本人 patch 返回 false', psOther.ok && psOther.v === false, j(psOther.v !== undefined ? psOther.v : psOther.err));

// ─── 已读 ──────────────────────────────────────────────
console.log('\n[已读]');
await admin.query(
  "insert into public.messages (session_id,user_id,role,content,character_id) values ($1,$2,'assistant','未读一条',$3)",
  [SID, U, OFFICIAL]);
const mr = await tryRpc('mark_read', [SID], U);
t('mark_read 计数正确', mr.ok && Number(mr.v) >= 1, j(mr.v !== undefined ? mr.v : mr.err));
const mrl = await admin.query(
  "select count(*)::int n from public.messages where session_id=$1 and read_at is null and role='assistant'", [SID]);
t('标记后无残留未读', Number(mrl.rows[0].n) === 0, String(mrl.rows[0].n));

// ─── 群聊 ──────────────────────────────────────────────
console.log('\n[群聊]');
const g2 = await admin.query(
  "insert into public.characters (owner_id,name,persona_text,example_dialogs) values ($1,'群友二','x','[]'::jsonb) returning id", [U]);
const g3 = await admin.query(
  "insert into public.characters (owner_id,name,persona_text,example_dialogs) values ($1,'群友三','x','[]'::jsonb) returning id", [U]);
const cg1 = await tryRpc('create_group', [[OFFICIAL, g2.rows[0].id], '双人', null], U);
t('create_group 双人成功（Free 上限 2）', cg1.ok, cg1.err);
const cg2 = await tryRpc('create_group', [[OFFICIAL, g2.rows[0].id, g3.rows[0].id]], U);
t('create_group 三人被拒', !cg2.ok && /GROUP_LIMIT_2/.test(cg2.err || ''), cg2.ok ? '竟然成功' : cg2.err);
const cg0 = await tryRpc('create_group', [[OFFICIAL]], U);
t('create_group 单人被拒', !cg0.ok && /NEED_TWO_MEMBERS/.test(cg0.err || ''), cg0.ok ? '竟然成功' : cg0.err);

// ─── 表情包 ────────────────────────────────────────────
console.log('\n[表情包]');
const items = JSON.stringify([{ path: 'a.png', caption: '笑' }, { path: 'b.png', caption: '哭' }]);
const as1 = await tryRpc('add_stickers', [null, '测试包', items], U);
t('add_stickers 返回新增数 = 2', as1.ok && Number(as1.v) === 2, as1.ok ? String(as1.v) : as1.err);
const sc = await tryRpcSet('sticker_catalog', [SID], U);
t('sticker_catalog 可调', sc.ok, sc.err);
t('catalog 含 caption 不含 path',
  Array.isArray(sc.v) && sc.v.length === 2 && 'caption' in sc.v[0] && !('path' in sc.v[0]), j(sc.v || sc.err));

// ─── 记忆 ──────────────────────────────────────────────
console.log('\n[记忆]');
const am = await tryRpc('add_memory', [OFFICIAL, SID, '我下周三是面试'], U);
t('add_memory 可调', am.ok, am.err);
const amc = await admin.query('select kind, salience, manual from public.memories where id=$1', [am.v]);
t('手动记忆 = fact + manual + 高 salience',
  amc.rows[0].kind === 'fact' && amc.rows[0].manual === true && Number(amc.rows[0].salience) > 0.9, j(amc.rows[0]));
const ame = await tryRpc('add_memory', [OFFICIAL, SID, '   '], U);
t('空记忆被拒', !ame.ok && /EMPTY/.test(ame.err || ''), ame.ok ? '竟然成功' : ame.err);

// ─── 好感度与阶段 ──────────────────────────────────────
console.log('\n[好感度与阶段]');
const priv = await admin.query(
  "select has_function_privilege('authenticated','public.bump_affinity(uuid,uuid,numeric,text)','execute') as aff, " +
  "has_function_privilege('authenticated','public.schedule_care(date)','execute') as care, " +
  "has_function_privilege('authenticated','public.bump_rule_hits(bigint[])','execute') as hits");
t('bump_affinity 未授权给 authenticated', priv.rows[0].aff === false, j(priv.rows[0]));
t('schedule_care 未授权给 authenticated', priv.rows[0].care === false);
t('bump_rule_hits 未授权给 authenticated', priv.rows[0].hits === false);

const st1 = await withRole('service', async (c) => {
  await c.query('select public.bump_affinity($1,$2,100,$3)', [SID, OFFICIAL, 't1']);
  const r = await c.query('select stage from public.relationship_stage where session_id=$1 and character_id=$2', [SID, OFFICIAL]);
  return r.rows[0].stage;
});
t('score=100 首次跃迁到 acquainted', st1 === 'acquainted', st1);

const st2 = await withRole('service', async (c) => {
  await c.query('select public.bump_affinity($1,$2,900,$3)', [SID, OFFICIAL, 't2']);
  const r = await c.query('select stage from public.relationship_stage where session_id=$1 and character_id=$2', [SID, OFFICIAL]);
  return r.rows[0].stage;
});
t('同一天内不再跃迁（半静态段稳定）', st2 === 'acquainted', st2);

const sc2 = await admin.query('select score from public.affinity_state where session_id=$1 and character_id=$2', [SID, OFFICIAL]);
t('好感度累加到 1000', Number(sc2.rows[0].score) === 1000, String(sc2.rows[0].score));

// ─── 主动关怀排期 ──────────────────────────────────────
console.log('\n[主动关怀排期]');
await admin.query(
  "update public.entitlements set tier='pro', proactive_per_day=1, expires_at=now()+interval '31 day' where user_id=$1", [U]);
const today = new Date().toISOString().slice(0, 10);
const n1 = await withRole('service', async (c) => {
  await c.query('select public.schedule_care($1)', [today]);
  const r = await c.query('select count(*)::int n from public.proactive_jobs where user_id=$1', [U]);
  return r.rows[0].n;
});
t('schedule_care 排上了任务', Number(n1) >= 1, String(n1));
const n2 = await withRole('service', async (c) => {
  await c.query('select public.schedule_care($1)', [today]);
  const r = await c.query('select count(*)::int n from public.proactive_jobs where user_id=$1', [U]);
  return r.rows[0].n;
});
t('同一天重复排期不产生第二条（幂等）', Number(n2) === Number(n1), n1 + ' → ' + n2);

// lite 档只在特定星期排期 —— and/or 优先级的回归测试
await admin.query("update public.entitlements set tier='lite', proactive_per_day=1 where user_id=$1", [V]);
await admin.query('delete from public.proactive_jobs where user_id=$1', [V]);
const liteN = await withRole('service', async (c) => {
  await c.query('select public.schedule_care($1)', [today]);
  const r = await c.query('select count(*)::int n from public.proactive_jobs where user_id=$1', [V]);
  return r.rows[0].n;
});
const dow = new Date().getUTCDay();
t('lite 档频率限制未被架空',
  (dow === 1 || dow === 4) ? Number(liteN) >= 1 : Number(liteN) === 0,
  'dow=' + dow + ' 排了 ' + liteN + ' 条');

// ─── 分享 ──────────────────────────────────────────────
console.log('\n[分享]');
const msgIds = (await admin.query('select id from public.messages where session_id=$1 limit 5', [SID])).rows.map((r) => r.id);
const cs = await tryRpc('create_share', [SID, msgIds, 'public'], U);
t('create_share 可调', cs.ok, cs.err);
const CODE = cs.ok ? cs.v : null;
t('短码只含 URL 安全字符', typeof CODE === 'string' && /^[A-Za-z0-9_-]{6,12}$/.test(CODE), String(CODE));

if (!CODE) {
  console.log('  SKIP 后续分享断言（create_share 未返回短码）');
} else {
  const rs = await tryRpc('resolve_share', [CODE], 'anon');
  t('resolve_share 匿名可调', rs.ok, rs.err);
  t('落地页能看到消息', rs.ok && Array.isArray(rs.v.messages) && rs.v.messages.length > 0, j(rs.v).slice(0, 120));
  t('落地页带角色名', rs.ok && /官方·测试/.test(j(rs.v)));
  const rsv = await admin.query('select views from public.share_links where id=$1', [CODE]);
  t('访问计数真的自增了', rsv.rowCount === 1 && Number(rsv.rows[0].views) >= 1, j(rsv.rows[0]));
}

const csOther = await tryRpc('create_share', [SID, msgIds], V);
t('非本人不能分享别人的会话', !csOther.ok && /NOT_OWNER/.test(csOther.err || ''), csOther.ok ? '竟然成功' : csOther.err);
const many = Array.from({ length: 25 }, () => '00000000-0000-0000-0000-000000000001');
const csMany = await tryRpc('create_share', [SID, many], U);
t('超 20 条被拒', !csMany.ok && /TOO_MANY|NO_MESSAGES/.test(csMany.err || ''), csMany.ok ? '竟然成功' : csMany.err);

// ─── 规则计数 ──────────────────────────────────────────
console.log('\n[规则计数]');
await admin.query(
  "insert into public.sensitive_rules (pattern, scope, action, reason) values ('测试规则XYZ','community','flag','测试') on conflict (pattern,scope) do nothing");
const ruleId = (await admin.query("select id from public.sensitive_rules where pattern='测试规则XYZ'")).rows[0].id;
const h0 = (await admin.query('select hits from public.sensitive_rules where id=$1', [ruleId])).rows[0].hits;
await withRole('service', (c) => c.query('select public.bump_rule_hits($1::bigint[])', [[ruleId, ruleId]]));
const h1 = (await admin.query('select hits from public.sensitive_rules where id=$1', [ruleId])).rows[0].hits;
t('bump_rule_hits 自增生效', Number(h1) === Number(h0) + 1, h0 + ' → ' + h1);
const rv = await admin.query('select v from public.rule_version where id=1');
t('规则改动触发版本号自增', Number(rv.rows[0].v) >= 2, String(rv.rows[0].v));

// ─── 未成年人限制 ──────────────────────────────────────
console.log('\n[未成年人]');
const mChar = await tryRpc('create_character', ['小明的角色', '', '', '', '[]'], MINOR);
t('未成年人账号可注册并建角色（有限使用）', mChar.ok, mChar.err);
const mPub = await tryRpc('publish_character', [mChar.v, 'public'], MINOR);
t('未成年人不能发布到广场',
  mPub.ok && (mPub.v === 'minors_blocked' || mPub.v === 'tier_too_low'),
  j(mPub.v !== undefined ? mPub.v : mPub.err));

// ─── 匿名底线 ──────────────────────────────────────────
console.log('\n[匿名底线]');
const anonSess = await tryRpcSet('list_sessions', [], 'anon');
t('匿名调 list_sessions 返回空而非泄漏', anonSess.ok && Array.isArray(anonSess.v) && anonSess.v.length === 0,
  j(anonSess.v || anonSess.err));
const anonChar = await tryRpc('create_character', ['x', '', '', '', '[]'], 'anon');
t('匿名不能建角色', !anonChar.ok, anonChar.ok ? '竟然返回 ' + j(anonChar.v) : anonChar.err);

// ─── 账号生命周期（010 的回归测试）─────────────────────
console.log('\n[账号生命周期]');
const ex = await tryRpc('export_bundle', [], U);
t('export_bundle 可调', ex.ok, ex.err);
const exTxt = j(ex.v);
t('导出含对话与记忆', /私密内容A|我爱吃火锅|面试/.test(exTxt), exTxt.slice(0, 80));
t('导出含角色与额度流水', /小明/.test(exTxt) && /ledger|credit_history/.test(exTxt));
t('★ 导出绝不含 API Key 密文', !/wrapped_dk|"ciphertext"|"enc_key"|"dk_iv"/.test(exTxt));
t('导出不含 Key 明文形态', !/sk-[A-Za-z0-9]{10,}/.test(exTxt));

const erNoConfirm = await tryRpc('erase_account', ['yes'], V);
t('注销必须输入确认词', erNoConfirm.ok && erNoConfirm.v.ok === false
  && erNoConfirm.v.code === 'CONFIRM_REQUIRED', j(erNoConfirm.v ?? erNoConfirm.err));
const vStill = await admin.query('select count(*)::int n from auth.users where id=$1', [V]);
t('确认词不对时账号完好', Number(vStill.rows[0].n) === 1, String(vStill.rows[0].n));

// 关键回归：V 有自建角色与账本，注销后角色必须消失而不是变成官方角色
await admin.query("update public.entitlements set tier='pro' where user_id=$1", [V]);
await tryRpc('create_character', ['V的私密角色', '', '', '', '[]'], V);
await tryRpc('my_usage_days', [30], V);
const vCharsBefore = await admin.query('select count(*)::int n from public.characters where owner_id=$1', [V]);
const vLedgerBefore = await admin.query('select count(*)::int n from public.ledger where user_id=$1', [V]);

const er = await tryRpc('erase_account', ['ERASE'], V);
t('erase_account(ERASE) 可调', er.ok && er.v && er.v.ok === true, j(er.v ?? er.err));

const vGone = await admin.query('select count(*)::int n from auth.users where id=$1', [V]);
t('账号已删除', Number(vGone.rows[0].n) === 0, String(vGone.rows[0].n));

// 精确按 owner 判定，不按名字 —— 按名字会被历史遗留数据污染（已误报过一次）
t('注销前确实存在 1 个自建角色（避免断言假通过）', Number(vCharsBefore.rows[0].n) === 1,
  String(vCharsBefore.rows[0].n));
const orphanByOwner = await admin.query(
  'select count(*)::int n from public.characters where owner_id = $1', [V]);
t('★ 注销后自建角色被级联删除，未变成官方角色', Number(orphanByOwner.rows[0].n) === 0,
  `owner=${V.slice(0, 8)} 仍有 ${orphanByOwner.rows[0].n} 条`);

const anyBadOfficial = await admin.query(
  "select count(*)::int n from public.characters where owner_id is null and review_status <> 'approved'");
t('库内不存在"未批准却像官方"的角色', Number(anyBadOfficial.rows[0].n) === 0, String(anyBadOfficial.rows[0].n));

const anonLedger = await admin.query(
  'select count(*)::int n from public.ledger_anonymized where user_id = ' +
  "md5('echosoul-retention-v1' || $1::text)::uuid", [V]);
t('账本被匿名化保留（财务凭证不丢）', Number(anonLedger.rows[0].n) === Number(vLedgerBefore.rows[0].n),
  `匿名表 ${anonLedger.rows[0].n} 条，原 ${vLedgerBefore.rows[0].n} 条`);
const rawLedger = await admin.query('select count(*)::int n from public.ledger where user_id=$1', [V]);
t('原账本中该用户的行已清除', Number(rawLedger.rows[0].n) === 0, String(rawLedger.rows[0].n));
const anonNoUsage = await admin.query(
  "select count(*)::int n from public.ledger_anonymized where model_usage is not null");
t('匿名化时一并清空了 usage 明细', Number(anonNoUsage.rows[0].n) === 0, String(anonNoUsage.rows[0].n));

// ─── 社区：发帖 → 举报 3 次 → 自动隐藏 ─────────────────
console.log('\n[社区与举报]');
// uq_report_once 禁止同一人重复举报同一目标，所以三枪必须来自三个不同账号。
const W = await mkUser('w');
const X = await mkUser('x');
const post = await admin.query(
  'insert into public.posts (author_id, kind, title, body, visibility, review_status) ' +
  "values ($1,'discussion','测试帖','正常内容','public','approved') returning id", [U]);
const POST = post.rows[0].id;
for (const reporter of [MINOR, W]) {
  await admin.query(
    'insert into public.reports (target_kind, target_id, reporter_id, reason, category) ' +
    "values ('post', $1, $2, '测试举报', 'spam')", [POST, reporter]);
}
const notYetHidden = await admin.query('select review_status from public.posts where id=$1', [POST]);
t('2 次举报尚未触发隐藏（阈值为 3）', notYetHidden.rows[0].review_status === 'approved',
  notYetHidden.rows[0].review_status);
await admin.query(
  'insert into public.reports (target_kind, target_id, reporter_id, reason, category) ' +
  "values ('post', $1, $2, '测试举报', 'spam')", [POST, X]);
const hidden = await admin.query('select review_status, report_count from public.posts where id=$1', [POST]);
t('第 3 次举报触发自动隐藏（非删除）', hidden.rows[0].review_status === 'hidden',
  j(hidden.rows[0]));
t('自动隐藏保留了内容本体可恢复', Number(hidden.rows[0].report_count) === 3, String(hidden.rows[0].report_count));

// 高危类别一次即隐藏
const post2 = await admin.query(
  'insert into public.posts (author_id, kind, title, body, visibility, review_status) ' +
  "values ($1,'discussion','高危测试','x','public','approved') returning id", [U]);
await admin.query(
  'insert into public.reports (target_kind, target_id, reporter_id, reason, category) ' +
  "values ('post', $1, $2, '测试', 'minor_sexual')", [post2.rows[0].id, W]);
const hidden2 = await admin.query('select review_status from public.posts where id=$1', [post2.rows[0].id]);
t('涉未成年人内容一次举报即隐藏', hidden2.rows[0].review_status === 'hidden', hidden2.rows[0].review_status);

// 举报人身份不外泄：U 只能看到自己提的
const otherReports = await withRole(U, (c) =>
  c.query('select count(*)::int n from public.reports where reporter_id <> $1', [U]));
t('看不到别人的举报', Number(otherReports.rows[0].n) === 0, String(otherReports.rows[0].n));

// ─── 成本可观测（011）───────────────────────────────────
console.log('\n[成本可观测]');
await admin.query("update public.entitlements set tier='ultra' where user_id=$1", [U]);
// 造 30 轮：20 轮命中 90%（健康）、10 轮无缓存（用来验算命中率与成本）
const mkTurn = (cached, prompt, cost, credit, ok = true) =>
  admin.query(
    'insert into public.chat_turns (user_id,character_id,session_id,model,' +
    'prompt_tokens,cached_tokens,completion_tokens,cost_cny,credit_charged,carried_tokens,ok) ' +
    "values ($1,$2,$3,'deepseek-chat',$4,$5,600,$6,$7,8192,$8)",
    [U, OFFICIAL, SID, prompt, cached, cost, credit, ok]);

for (let i = 0; i < 20; i++) await mkTurn(9000, 10000, 0.0035, 0.021, true);
for (let i = 0; i < 10; i++) await mkTurn(0, 10000, 0.0112, 0.021, true);
// 失败轮不应计入统计
for (let i = 0; i < 3; i++) await mkTurn(0, 10000, 0.005, 0, false);

const hr = await tryRpcSet('cache_hit_rate', [null, null], 'service');
t('cache_hit_rate 可调', hr.ok, hr.err);
const hrRows = Array.isArray(hr.v) ? hr.v : [];
const hrTotal = hrRows.reduce((a, r) => ({
  turns: a.turns + Number(r.turns), prompt: a.prompt + Number(r.prompt_tokens),
  cached: a.cached + Number(r.cached_tokens),
}), { turns: 0, prompt: 0, cached: 0 });
t('只统计成功的轮次（失败轮被排除）', hrTotal.turns === 30, String(hrTotal.turns));
t('命中率按 (cached/prompt) 计算而非拍脑袋',
  Math.abs(hrTotal.cached / hrTotal.prompt - 0.6) < 0.001,
  (hrTotal.cached / hrTotal.prompt).toFixed(4) + ' 期望 0.6000');

const hc = await tryRpcSet('cache_hit_by_character', [null], 'service');
t('cache_hit_by_character 可调并带角色名',
  hc.ok && Array.isArray(hc.v) && hc.v.length >= 1 && /官方·测试/.test(j(hc.v)),
  hc.ok ? j(hc.v).slice(0, 100) : hc.err);

const tm = await tryRpcSet('tier_margin', [30], 'service');
t('tier_margin 可调', tm.ok, tm.err);
const ultra = (Array.isArray(tm.v) ? tm.v : []).find((r) => r.tier === 'ultra');
t('毛利倍率算得出且分级正确',
  ultra && Number(ultra.retail_multiple) > 0,
  ultra ? `multiple=${ultra.retail_multiple} alert=${ultra.alert}` : '未找到 ultra 档');
// 合成数据：30 轮 credit 0.021 合计 0.63，cost 20×0.0035+10×0.0112=0.182 ⇒ 倍数约 3.46 ⇒ critical
t('低于 3.5× 被标为 critical（告警真的会触发）',
  ultra && ultra.alert === 'critical',
  ultra ? String(ultra.alert) : 'n/a');

const health = await tryRpc('check_prefix_health', [60, 0.90], 'service');
t('check_prefix_health 可调', health.ok, health.err);
t('命中率 60% 低于 90% ⇒ 判定不健康', health.ok && health.v.ok === false,
  j(health.v ?? health.err));
t('告警写进了 admin_audit', await (async () => {
  const a = await admin.query(
    "select count(*)::int n from public.admin_audit where action='prefix_health_alarm'");
  return Number(a.rows[0].n) >= 1;
})(), '未找到告警记录');
t('能定位到具体可疑角色', health.ok && /官方·测试/.test(j(health.v.suspect_characters)),
  j(health.ok ? health.v.suspect_characters : health.err));

// 低样本时必须跳过而不是误报。
// ⚠ 前提要造对：刚插入的行就在当前时间，任何 ≥1 分钟的窗口都会包含它们，
//   所以先把这批轮次挪到 3 小时前，让"最近 60 分钟"真的为空。
await admin.query(
  "update public.chat_turns set created_at = now() - interval '3 hours' where user_id=$1", [U]);
const lowSample = await tryRpc('check_prefix_health', [60, 0.99], 'service');
t('样本不足时跳过判定（不误报）',
  lowSample.ok && lowSample.v.skipped === true && lowSample.v.reason === 'LOW_SAMPLE',
  j(lowSample.v ?? lowSample.err));
t('低样本时 turns 确实为 0（证明真的走到了跳过分支）',
  lowSample.ok && Number(lowSample.v.turns) === 0, j(lowSample.v ?? lowSample.err));

const mt = await tryRpcSet('my_turns', [10], U);
t('my_turns 可调且只回自己那几行', mt.ok && Array.isArray(mt.v) && mt.v.length === 10,
  mt.ok ? String(mt.v.length) : mt.err);
t('my_turns 不暴露成本价（只有扣费额）',
  mt.ok && mt.v.length > 0 && !('cost_cny' in mt.v[0]) && 'credit' in mt.v[0],
  mt.ok && mt.v[0] ? Object.keys(mt.v[0]).join(',') : 'n/a');

const mtOther = await tryRpcSet('my_turns', [10], V);
t('别人看不到我的轮次明细',
  !mtOther.ok || (Array.isArray(mtOther.v) && mtOther.v.length === 0),
  mtOther.ok ? String(mtOther.v.length) + ' 行' : mtOther.err);

const costView = await admin.query('select count(*)::int n from public.admin_cost_daily');
t('admin_cost_daily 视图可用', Number(costView.rows[0].n) >= 1, String(costView.rows[0].n));
const costViewLocked = await withRole(U, (c) =>
  c.query('select count(*)::int n from public.admin_cost_daily')).then(() => false).catch(() => true);
t('成本视图对普通用户不可读', costViewLocked === true);

// ─── 合规能力（012）─────────────────────────────────────
console.log('\n[使用时长与提醒]');
// 心跳计时：只有距上次 ≤90 秒的间隔才算活跃。
// 不这么设计的话，挂着页面去吃饭会被算成使用，然后弹出"你已使用 8 小时"。
const hb0 = await tryRpc('usage_heartbeat', [SID], U);
t('首次心跳不计入时长（没有上一次参照）',
  hb0.ok && Number(hb0.v.today_seconds) === 0, j(hb0.v ?? hb0.err));

const hb1 = await tryRpc('usage_heartbeat', [SID], U);
t('90 秒内的心跳被计入活跃时长',
  hb1.ok && Number(hb1.v.today_seconds) >= 1, j(hb1.v ?? hb1.err));
const afterH1 = Number(hb1.v.today_seconds);

// 把上次心跳挪到 10 分钟前：这一次心跳应当**只加 0 秒**，不能把 600 秒空档算进来。
// ⚠ 不能用"再打一次心跳看总时长没变"来验 —— 这一次心跳本身会把 last_beat_at
//   重置成 now，紧接着的下一次就会合法地计入，那样断言必然失败（已踩过）。
await admin.query(
  "update public.usage_daily set last_beat_at = now() - interval '10 minutes' where user_id=$1", [U]);
const hb2 = await tryRpc('usage_heartbeat', [SID], U);
const afterGap = Number(hb2.v.today_seconds);
t('超过 90 秒的空档不计入（挂机不算使用）',
  hb2.ok && afterGap - afterH1 <= 2,
  `心跳前 ${afterH1}s → 空档后 ${afterGap}s（若把 600s 算进来会接近 600）`);

// 成人 2 小时提醒：直接把累计时长顶到阈值再打一次心跳
await admin.query(
  "update public.usage_daily set active_seconds = 7200, notified = '{}'::jsonb where user_id=$1", [U]);
const hbAdult = await tryRpc('usage_heartbeat', [SID], U);
t('成人累计 2 小时触发提醒',
  hbAdult.ok && j(hbAdult.v.fire).includes('adult_2h'), j(hbAdult.v ?? hbAdult.err));
const hbAdult2 = await tryRpc('usage_heartbeat', [SID], U);
t('同一天不重复触发同一条提醒',
  hbAdult2.ok && !j(hbAdult2.v.fire).includes('adult_2h'), j(hbAdult2.v ?? hbAdult2.err));

// 未成年人 40 分钟提醒 + 宵禁提示
const hbM0 = await tryRpc('usage_heartbeat', [null], MINOR);
await admin.query(
  "update public.usage_daily set active_seconds = 2400, notified = '{}'::jsonb where user_id=$1", [MINOR]);
const hbMinor = await tryRpc('usage_heartbeat', [null], MINOR);
t('未成年人标记为 is_minor', hbMinor.ok && hbMinor.v.is_minor === true, j(hbMinor.v ?? hbMinor.err));
t('未成年人累计 40 分钟触发提醒',
  hbMinor.ok && j(hbMinor.v.fire).includes('minor_40min'), j(hbMinor.v ?? hbMinor.err));
t('未成年人不会收到成人那条（阈值分流正确）',
  hbMinor.ok && !j(hbMinor.v.fire).includes('adult_2h'), j(hbMinor.v.fire));
void hbM0;

const myUse = await tryRpcSet('my_usage', [7], U);
t('my_usage 可读自己的时长', myUse.ok && Array.isArray(myUse.v) && myUse.v.length >= 1,
  myUse.ok ? String(myUse.v.length) + ' 天' : myUse.err);
const myUseOther = await tryRpcSet('my_usage', [7], V);
t('看不到别人的时长', !myUseOther.ok || myUseOther.v.length === 0,
  myUseOther.ok ? String(myUseOther.v.length) : myUseOther.err);

console.log('\n[AI 标识与反诈页]');
const lab = await tryRpc('label_asset', ['image', 'test-asset', 'deepseek-chat', null], U);
t('label_asset 可调', lab.ok, lab.err);
t('返回的元数据字段固定（导出端不许自行发挥）',
  lab.ok && lab.v.meta.ai_generated === true && lab.v.meta.generator === 'echosoul'
  && typeof lab.v.meta.asset_id === 'string' && lab.v.meta.label_version === 'v1',
  j(lab.ok ? lab.v.meta : lab.err));
const labBad = await tryRpc('label_asset', ['nonsense', null, '', null], U);
t('非法 kind 被拒', labBad.ok && labBad.v.ok === false, j(labBad.v ?? labBad.err));

const chans = await tryTable('official_channels', 'anon', 'enabled');
t('官方渠道页匿名可读（反诈页必须在登录前就能看）',
  chans.ok && Array.isArray(chans.v) && chans.v.length >= 4, chans.ok ? String(chans.v.length) : chans.err);
const rules = await tryTable('never_do_rules', 'anon', 'enabled');
t('11 条"我们绝不会做"匿名可读',
  rules.ok && Array.isArray(rules.v) && rules.v.length === 11,
  rules.ok ? String(rules.v.length) : rules.err);

console.log('\n[监护人通道]');
// 监护人可能没有账号，所以提交必须允许匿名
const gReq = await tryRpc('submit_guardian_request',
  ['erase_account', 'kid@example.invalid', '孩子是未成年人，希望注销其账号', 'parent@example.invalid'], 'anon');
t('监护人请求允许匿名提交', gReq.ok && gReq.v.ok === true, j(gReq.v ?? gReq.err));
t('返回可核对的受理号', gReq.ok && /^GR\d{8}/.test(String(gReq.v.request_no)), j(gReq.ok ? gReq.v.request_no : ''));
t('明示 7 个工作日响应（快于一般请求的 15 天）',
  gReq.ok && Number(gReq.v.response_within_days) === 7, j(gReq.ok ? gReq.v : ''));

const gStat = await tryRpc('guardian_status', [gReq.v.request_no], 'anon');
t('凭受理号可匿名查进度', gStat.ok && gStat.v.ok === true && gStat.v.status === 'received',
  j(gStat.v ?? gStat.err));
t('进度查询不回任何账号内容',
  gStat.ok && !j(gStat.v).includes('kid@example.invalid'), j(gStat.v));

const grBad = await tryRpc('submit_guardian_request', ['erase_account', '', '', ''], 'anon');
t('缺说明或联系方式被拒', grBad.ok && grBad.v.ok === false, j(grBad.v ?? grBad.err));

// 请求明细表任何人都不能直接读（含提交者自己）
const grTable = await tryTable('guardian_requests', U, 'true limit 5');
t('监护人明细表对登录用户不可直接读', grTable.ok === false,
  grTable.ok ? `泄漏 ${grTable.v.length} 行` : '');

console.log('\n[提示去重]');
const nt1 = await tryRpc('claim_notice', ['adult_2h_tip', false], U);
t('首次认领提示返回 true', nt1.ok && nt1.v === true, j(nt1.v ?? n1.err));
const nt2 = await tryRpc('claim_notice', ['adult_2h_tip', false], U);
t('不可重复的提示第二次返回 false', nt2.ok && nt2.v === false, j(nt2.v ?? n2.err));
const nt3 = await tryRpc('claim_notice', ['adult_2h_tip', true], U);
t('可重复提示不受影响', nt3.ok && nt3.v === true, j(nt3.v ?? n3.err));

// ─── 清理 ──────────────────────────────────────────────
if (!KEEP) {
  console.log('\n[清理]');
  // 按前缀清：之前每次中途崩掉的运行都会留下 3 个用户，实测累积到 15 个。
  // 断言只看 rpc- 前缀，不看全库计数 —— 后者会把别人建的数据算进来造成误报。
  const allRpc = await admin.query(
    "select id from auth.users where email like 'rpc-%'");
  const ids = allRpc.rows.map((r) => r.id);
  await withRole('service', (c) => c.query(
    "select set_config('app.ledger_purge','on',false), set_config('app.purge_reason','verify-rpc cleanup',false)"));
  await withRole('service', async (c) => {
    await c.query('delete from public.ledger where user_id = any($1::uuid[])', [ids]);
    await c.query('delete from public.balances where user_id = any($1::uuid[])', [ids]);
    // chat_turns.user_id 刻意没有外键（成本事实表需独立于账号留存），
    // 所以删用户不会带走它。先按本次 ids 清，再扫一遍孤儿 ——
    // 早期运行的产物其 user_id 已不在 profiles 里，按 ids 删不掉，
    // 而这些不可归因的行会污染后续统计断言（已实际误报过一次）。
    await c.query('delete from public.chat_turns where user_id = any($1::uuid[])', [ids]);
    await c.query(
      'delete from public.chat_turns t where not exists ' +
      '(select 1 from public.profiles p where p.id = t.user_id)');
  });
  const r = await admin.query('delete from auth.users where id = any($1::uuid[])', [ids]);
  t('清理本脚本创建的全部测试用户（含历史遗留）', r.rowCount === ids.length,
    `删了 ${r.rowCount}，共发现 ${ids.length}`);

  const left = await admin.query(
    'select (select count(*) from auth.users where email like $1) u, ' +
    '(select count(*) from public.characters where owner_id in ' +
      "(select id from auth.users where email like $1)) c, " +
    '(select count(*) from public.share_links) s, ' +
    '(select count(*) from public.proactive_jobs) j', ['rpc-%']);
  const row = left.rows[0];
  // share_links / proactive_jobs 的外键是 on delete set null / cascade，
  // 用户删掉后可能留下 user_id 为空的孤儿分享记录，一并检查
  t('库内无 rpc 测试残留',
    Number(row.u) === 0 && Number(row.c) === 0 && Number(row.j) === 0, j(row));
  if (Number(row.s) > 0) {
    await admin.query('delete from public.share_links where user_id is null');
    const s2 = await admin.query('select count(*)::int n from public.share_links');
    t('孤儿分享链接已回收', Number(s2.rows[0].n) === 0, String(s2.rows[0].n));
  }
} else {
  console.log('\n[清理] --keep，保留测试数据');
}

admin.release();
await pool.end();
console.log('\n' + '='.repeat(54));
if (fails.length) {
  console.log('✗ ' + fails.length + ' 项失败 / 共 ' + (pass + fails.length));
  for (const f of fails) console.log('   - ' + f);
  process.exit(1);
}
console.log('✓ 全部通过  ' + pass + ' 项 RPC 真调用验收');
