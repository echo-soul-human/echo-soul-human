/**
 * tests/run.mjs — 无框架单测
 *
 * 为什么自建而不引 vitest：被测的是 Edge Function 里的纯函数，
 * 引框架会引入 Node 与 Deno 的 TS 语义差异（parameter property 就是实例），
 * 反而制造"本地绿、线上炸"。让 Node 直接加载 .ts，测的就是真代码。
 *
 * 用法：npm test
 */
import { md5 } from '../supabase/functions/_shared/md5.ts';
import { apiSign, stableStringify, webhookSignStr, verifyWebhookSign } from '../supabase/functions/_shared/afdian.ts';
import { buildStaticPrefix, buildDynamicParts } from '../supabase/functions/_shared/prefix.ts';
import { estimateRequest } from '../supabase/functions/_shared/providers/types.ts';
import { isPrivateIp } from '../supabase/functions/_shared/ssrf.ts';

let pass = 0;
const failures = [];

function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { failures.push(name + ' -> ' + e.message); console.log('  FAIL ' + name + ' -> ' + e.message); }
}
async function ta(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { failures.push(name + ' -> ' + e.message); console.log('  FAIL ' + name + ' -> ' + e.message); }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || '') + ' expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
}
function truthy(a, msg) { if (!a) throw new Error((msg || '') + ' assertion was falsy'); }

// ── md5 ────────────────────────────────────────────────
// 三条公认固定向量做冒烟；其余一律与 node 内置 md5 实时对拍，
// 避免"凭记忆写期望值"把正确实现判成失败。
console.log('\n[md5]');
t('empty', () => eq(md5(''), 'd41d8cd98f00b204e9800998ecf8427e'));
t('abc', () => eq(md5('abc'), '900150983cd24fb0d6963f7d28e17f72'));
t('fox sentence', () => eq(md5('The quick brown fox jumps over the lazy dog'), '9e107d9d372bb6826bd81d3542a419d6'));
t('output is 32 lowercase hex', () => truthy(/^[0-9a-f]{32}$/.test(md5('anything'))));

const nodeMd5 = (await import('node:crypto')).default.createHash;
const oracle = (s) => nodeMd5('md5').update(s, 'utf8').digest('hex');

t('cross-check vs node crypto: 55 bytes (padding boundary)', () => eq(md5('a'.repeat(55)), oracle('a'.repeat(55))));
t('cross-check vs node crypto: 56 bytes (spills to 2nd block)', () => eq(md5('a'.repeat(56)), oracle('a'.repeat(56))));
t('cross-check vs node crypto: 64 bytes (exact block)', () => eq(md5('a'.repeat(64)), oracle('a'.repeat(64))));
t('cross-check vs node crypto: chinese UTF-8 path', () => eq(md5('中文'), oracle('中文')));
t('cross-check vs node crypto: emoji + surrogate pair', () => eq(md5('你😀好'), oracle('你😀好')));
t('cross-check vs node crypto: 1000 random inputs', () => {
  const alphabet = 'abcXYZ019 \n\t{}"\'\\中文字😀';
  for (let i = 0; i < 1000; i++) {
    let s = '';
    const len = Math.floor(Math.random() * 200);
    for (let j = 0; j < len; j++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (md5(s) !== oracle(s)) throw new Error('mismatch on ' + JSON.stringify(s));
  }
});

// ── afdian signature ───────────────────────────────────
console.log('\n[afdian signature]');
t('API sign matches official doc vector', () => eq(
  apiSign('123', stableStringify({ a: 333 }), 1624339905, 'abc'),
  'a4acc28b81598b7e5d84ebdc3e91710c'));
t('stableStringify normalizes key order', () => eq(
  stableStringify({ c: 1, a: { z: 1, y: 2 }, b: 3 }), '{"a":{"y":2,"z":1},"b":3,"c":1}'));
t('sign is key-order independent', () => eq(
  apiSign('t', stableStringify({ b: 2, a: 1 }), 1, 'u'),
  apiSign('t', stableStringify({ a: 1, b: 2 }), 1, 'u')));
t('webhook sign_str order out_trade_no+user_id+plan_id+total_amount', () => eq(
  webhookSignStr({ out_trade_no: 'T1', user_id: 'U2', plan_id: 'P3', total_amount: '5.00' }), 'T1U2P35.00'));
t('empty plan_id yields no literal undefined', () => eq(
  webhookSignStr({ out_trade_no: 'T1', user_id: 'U2', plan_id: '', total_amount: '5.00' }), 'T1U25.00'));
t('missing fields do not throw', () => eq(typeof webhookSignStr({}), 'string'));
await ta('forged signature rejected', async () => truthy(
  !(await verifyWebhookSign({ out_trade_no: 'T', user_id: 'U', plan_id: 'P', total_amount: '1' }, 'ZmFrZQ==')),
  'forged signature accepted'));
await ta('absent signature rejected', async () => truthy(
  !(await verifyWebhookSign({ out_trade_no: 'T', user_id: 'U', plan_id: 'P', total_amount: '1' }, undefined))));

// ── static prefix (cost-critical) ──────────────────────
console.log('\n[static prefix]');
const base = {
  name: 'TestRole', tagline: 'one line', persona: 'persona body',
  exampleDialogs: [{ user: 'hi', role: 'yeah, here' }],
  behaviorNotes: '', antiDriftReply: 'pull back', boundaries: '', stage: 'stranger',
};
t('same input renders byte-identical', () => eq(buildStaticPrefix(base), buildStaticPrefix(base)));
t('dialogs truncated to fixed cap (no length drift)', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ user: 'u' + i, role: 'r' + i }));
  eq(buildStaticPrefix({ ...base, exampleDialogs: many }),
     buildStaticPrefix({ ...base, exampleDialogs: many.slice(0, 12) }));
});
t('control chars stripped', () => {
  const dirty = { ...base, persona: 'a' + String.fromCharCode(0) + 'b' + String.fromCharCode(127) + 'c' };
  eq(buildStaticPrefix(dirty), buildStaticPrefix({ ...base, persona: 'abc' }));
});
t('stage change alters prefix (at most once per day)', () => truthy(
  buildStaticPrefix(base) !== buildStaticPrefix({ ...base, stage: 'close' })));
t('unknown stage falls back to stranger deterministically', () => eq(
  buildStaticPrefix({ ...base, stage: 'nonsense' }), buildStaticPrefix(base)));
t('prefix contains no timestamp-like digits from our own code', () => truthy(
  !/19|20\d\d-\d\d-\d\d/.test(buildStaticPrefix(base))));

// ── dynamic part ordering ──────────────────────────────
console.log('\n[dynamic assembly]');
const dyn = buildDynamicParts({
  recalled: [{ text: 'user likes hotpot', kind: 'fact' }],
  history: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }],
  userContent: 'now', balanceHint: 'left 12.5',
});
t('recall injected before history', () => truthy(
  JSON.stringify(dyn[0]).includes('hotpot')));
t('user turn is last message', () => eq(dyn[dyn.length - 1].role, 'user'));
t('balance hint rides on the last message only', () => truthy(
  JSON.stringify(dyn[dyn.length - 1]).includes('12.5') &&
  !JSON.stringify(dyn.slice(0, -1)).includes('12.5')));

// ── token estimate monotonicity ────────────────────────
console.log('\n[token estimate]');
t('longer input costs more', () => truthy(
  estimateRequest({ staticPrefix: 'x'.repeat(2000), dynamic: [{ role: 'user', content: 'y' }], model: 'm', maxTokens: 100, temperature: 1 }).promptTokens >
  estimateRequest({ staticPrefix: 'x', dynamic: [{ role: 'user', content: 'y' }], model: 'm', maxTokens: 100, temperature: 1 }).promptTokens));
t('never returns NaN', () => truthy(Number.isFinite(
  estimateRequest({ staticPrefix: '', dynamic: [], model: 'm', maxTokens: 0, temperature: 1 }).total)));

// ── SSRF ip classification ─────────────────────────────
console.log('\n[ssrf ip]');
for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', '224.0.0.1']) {
  t('blocks ' + ip, () => truthy(isPrivateIp(ip), ip + ' should be blocked'));
}
for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.1.1', '2001:4860:4860::8888']) {
  t('allows ' + ip, () => truthy(!isPrivateIp(ip), ip + ' should be allowed'));
}
t('malformed ipv4 treated as unsafe', () => truthy(isPrivateIp('999.1.1.1')));

// ── Pages base 推导 ──────────────────────────────────────
console.log('\n[pages base]');
const { normalizeBase, baseFromRepository, resolveBase } = await import(
  '../scripts/pages-base.mjs');

t('normalizeBase 补前导与尾斜杠', () => eq(normalizeBase('echosoul'), '/echosoul/'));
t('normalizeBase 空值归一为根路径', () => eq(normalizeBase(''), '/'));
t('normalizeBase 保留已有尾斜杠', () => eq(normalizeBase('/a/b/'), '/a/b/'));
t('profile 仓库（repo 名等于 owner）推导为根路径', () =>
  eq(baseFromRepository({ GITHUB_REPOSITORY: 'echo-soul-human/echo-soul-human' }), '/'));
t('profile 仓库判定大小写不敏感', () =>
  eq(baseFromRepository({ GITHUB_REPOSITORY: 'FooBar/foobar' }), '/'));
t('普通仓库推导为 /<repo>/', () =>
  eq(baseFromRepository({ GITHUB_REPOSITORY: 'echo-soul-human/echosoul' }), '/echosoul/'));
t('无 GITHUB_REPOSITORY 返回 null 交回上层', () =>
  eq(baseFromRepository({}), null));
t('ECHOSOUL_BASE 显式覆盖优先级最高', () =>
  eq(resolveBase({ env: { ECHOSOUL_BASE: '/x', GITHUB_REPOSITORY: 'a/a' } }).base, '/x/'));
t('推导命中时来源标记为 GITHUB_REPOSITORY', () =>
  eq(resolveBase({ env: { GITHUB_REPOSITORY: 'o/r' } }).source, 'GITHUB_REPOSITORY'));

// ───────────────────────────────────────────────────────
console.log('\n' + '='.repeat(52));
if (failures.length) {
  console.log('FAILED ' + failures.length + ' / ' + (pass + failures.length));
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('ALL PASSED  ' + pass + ' assertions');
