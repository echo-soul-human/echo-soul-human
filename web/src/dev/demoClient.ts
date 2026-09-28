/**
 * demoClient.ts — 离线演示用的 supabase 客户端垫片
 *
 * 目的：让整套界面在**后端未接通**的情况下也能看。库是空的、Edge Function 还没部署，
 * 直接打开只能看到空态，等于没法评审视觉与交互。演示模式把"能不能看"与
 * "后端通没通"解耦。
 *
 * 实现方式：在 lib/supabase.ts 那一层替换客户端，而不是给 rpc.ts 里
 * 每个函数加演示分支 —— 那样要改二十处，而且每加一个接口就漏一处。
 *
 * ⚠ 只在 demoMode() 为真时启用。它不做任何写操作，接受写入并假装成功，
 *   但立即读回时仍返回原始样本（刷新即回到演示初态）。
 */
import {
  DEMO_CHARACTERS, DEMO_SESSIONS, DEMO_MESSAGES, DEMO_MEMORIES,
  DEMO_CREDIT, DEMO_PLANS, DEMO_LEDGER, DEMO_TURNS, DEMO_PLAZA,
  DEMO_COMMENTS, DEMO_CHANNELS, DEMO_NEVER_RULES, DEMO_BYOK, DEMO_USAGE,
  DEMO_SESSION_ID,
} from './sampleData';

/** 演示模式开关：?demo=1 显式开启，或本地开发时默认开（生产永远关） */
export function demoMode(): boolean {
  if (typeof window === 'undefined') return false;
  const q = new URLSearchParams(window.location.search);
  if (q.get('demo') === '1') {
    localStorage.setItem('echosoul.demo', '1');
    return true;
  }
  if (q.get('demo') === '0') {
    localStorage.removeItem('echosoul.demo');
    return false;
  }
  // 生产（import.meta.env.PROD）绝不自动进演示模式，避免误以为线上有数据
  return !import.meta.env.PROD && localStorage.getItem('echosoul.demo') === '1';
}

const DEMO_USER = {
  id: 'demo-user-0000-0000-000000000001',
  email: 'demo@echosoul.local',
  is_anonymous: true,
  created_at: new Date(Date.now() - 86400_000 * 40).toISOString(),
};

const DEMO_SESSION = {
  access_token: 'demo-token',
  refresh_token: 'demo-refresh',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: DEMO_USER,
};

/**
 * 构造带**全部可过滤字段**的完整行，然后才过滤。
 *
 * ⚠ 顺序不能反：先前写成"先按 session_id 过滤、之后 map 里才补 session_id"，
 *   于是 DEMO_MESSAGES 里没有该字段时 eq 恒不成立，对话页一条消息都出不来。
 *   同类问题在 ledger（缺 user_id）上也出现过一次。
 *   凡是页面会拿来 eq 的字段，必须在过滤前就存在。
 */
function rowsFor(table: string, filter: Record<string, unknown>): unknown[] {
  // 样本行是具体接口（DemoCharacter 等），没有索引签名，
  // 所以这里统一按 object 收、内部断言，避免每个调用点都写 as unknown as Record。
  const eq = (row: object, k: string) =>
    filter[k] === undefined || (row as Record<string, unknown>)[k] === filter[k];

  const withIds = <T extends object>(row: T, extra: Record<string, unknown> = {}) => ({
    user_id: DEMO_USER.id,
    ...extra,
    ...row,
  });

  switch (table) {
    case 'characters':
      return DEMO_CHARACTERS
        .map((c) => withIds({
          ...c,
          // 列表页要的窄字段
          ...(filter.select_narrow ? { name: c.name, avatar_path: c.avatar_path } : {}),
        }))
        .filter((c) => eq(c, 'id') && eq(c, 'visibility'));

    case 'session_members':
      return DEMO_SESSIONS
        .map((s) => withIds({ session_id: s.id, character_id: s.character_ids[0], seat: 1 }))
        .filter((m) => eq(m, 'session_id'));

    case 'sessions':
      return DEMO_SESSIONS
        .map((s) => withIds({ ...s }))
        .filter((s) => eq(s, 'id') && eq(s, 'user_id') && eq(s, 'kind'));

    case 'messages':
      return DEMO_MESSAGES
        .map((m) => withIds({
          ...m,
          session_id: DEMO_SESSION_ID,
          origin: 'client',
          read_at: null,
          usage_prompt: 8400, usage_completion: 460, usage_cached: 7400,
          cost_actual: 0.0031,
          request_id: null,
        }))
        .filter((m) => eq(m, 'session_id') && eq(m, 'user_id') && eq(m, 'role'));

    case 'memories':
      return DEMO_MEMORIES
        .map((m) => withIds({
          ...m,
          character_id: 'ch-shenyan',
          session_id: DEMO_SESSION_ID,
          embedding: null, source_msg_ids: [], recalled_count: 3, invalidated_at: null,
        }))
        .filter((m) => eq(m, 'id') && eq(m, 'character_id') && eq(m, 'user_id'));

    case 'entitlements':
      return [{ user_id: DEMO_USER.id, ...DEMO_CREDIT, character_slots: 4, carry_tokens: 49152, carry_default: 49152, recall_topk: 8, group_member_max: 4, skin_quota: 8, sticker_quota: 500, proactive_per_day: 1, window_limit: 262144 }];

    case 'balances':
      return [{ user_id: DEMO_USER.id, granted: DEMO_CREDIT.granted, spent: DEMO_CREDIT.spent, frozen: DEMO_CREDIT.frozen, usable: DEMO_CREDIT.usable, tts_granted: 200000, tts_spent: 13600, refreshed_at: new Date().toISOString() }];

    case 'plan_catalog':
      return DEMO_PLANS;

    case 'ledger':
      // ⚠ 必须带 user_id：页面按 user_id 过滤，样本里没有这个字段时
      //   eq 恒不成立，查出来是空的（额度页的消耗流水就因此空过一次）。
      return DEMO_LEDGER
        .filter((l) => eq(l, 'id') && eq(l, 'user_id') && eq(l, 'type'))
        .map((l) => ({ ...l, user_id: DEMO_USER.id }));

    case 'orders':
    case 'order_history':
      return [
        { id: 'o-1', external_id: '20260926120000000000000001', plan_ref: 'pro_31', tier: 'pro', is_addon: false, amount_cny: 49, status: 'granted', granted_at: new Date(Date.now() - 86400_000 * 19).toISOString(), created_at: new Date(Date.now() - 86400_000 * 19).toISOString() },
        { id: 'o-2', external_id: '20260812093000000000000002', plan_ref: 'pack_18', tier: 'free', is_addon: true, amount_cny: 18, status: 'granted', granted_at: new Date(Date.now() - 86400_000 * 45).toISOString(), created_at: new Date(Date.now() - 86400_000 * 45).toISOString() },
      ].filter((o) => eq(o, 'id'))
        .map((o) => ({ ...o, user_id: DEMO_USER.id }));

    case 'byok_profiles':
    case 'byok_profiles_public':
      return DEMO_BYOK.map((b) => ({ ...b, user_id: DEMO_USER.id }));

    case 'sticker_packs':
      return [{ id: 'sp-1', user_id: DEMO_USER.id, name: '我的表情', enabled: true, created_at: new Date().toISOString() }];

    case 'stickers':
      return [
        { id: 'st-1', pack_id: 'sp-1', user_id: DEMO_USER.id, path: '/emoji/hug.png', caption: '抱抱', token: 'hug0000001', created_at: new Date().toISOString() },
        { id: 'st-2', pack_id: 'sp-1', user_id: DEMO_USER.id, path: '/emoji/cry.png', caption: '哭了', token: 'cry0000002', created_at: new Date().toISOString() },
        { id: 'st-3', pack_id: 'sp-1', user_id: DEMO_USER.id, path: '/emoji/angry.png', caption: '生气了', token: 'ang0000003', created_at: new Date().toISOString() },
      ];

    case 'posts':
      return DEMO_PLAZA.map((p) => ({ ...p, author_id: 'u-plaza', review_status: 'approved', visibility: 'public', kind: 'card', image_path: null, character_id: p.character_id })).filter((p) => eq(p, 'id'));

    case 'post_comments':
      return DEMO_COMMENTS.map((c) => ({ ...c, post_id: 'p-1', author_id: 'u-c', parent_id: null, review_status: 'approved' })).filter((c) => eq(c, 'post_id'));

    case 'official_channels':
      return DEMO_CHANNELS;

    case 'never_do_rules':
      return DEMO_NEVER_RULES.map((text, i) => ({ id: i + 1, text, sort: (i + 1) * 10, enabled: true }));

    case 'usage_daily':
      return DEMO_USAGE.map((u) => ({ ...u, user_id: DEMO_USER.id }));

    case 'notify_prefs':
      return [{ user_id: DEMO_USER.id, care_enabled: true, per_character: {}, hide_content: false }];

    case 'relationship_stage':
      return [
        { session_id: DEMO_SESSION_ID, character_id: 'ch-shenyan', stage: 'ambiguous', changed_at: new Date(Date.now() - 86400_000 * 3).toISOString() },
        { session_id: 'se-demo-2', character_id: 'ch-linwan', stage: 'close', changed_at: new Date(Date.now() - 86400_000 * 6).toISOString() },
      ];

    case 'announcements':
      return [{ id: 1, slug: 'v010', title: 'v0.1.0 —— 第一个能聊起来的版本', body: '对话、记忆、额度、爱发电到账都已经打通。', kind: 'info', published: true, starts_at: new Date().toISOString(), ends_at: null, created_at: new Date().toISOString() }];

    default:
      return [];
  }
}

/** 该表的行里，哪个字段用于 eq 过滤（供链式 builder 收集条件） */
const FILTER_KEYS = ['id', 'session_id', 'character_id', 'user_id', 'pack_id', 'post_id', 'role', 'kind', 'tier', 'enabled', 'visibility'];

interface Builder {
  [k: string]: unknown;
}

/**
 * 链式查询构造器。await 它时执行并返回 { data, error }。
 * 只实现应用里真正用到的方法；遇到没实现的就返回自身，保证链不断。
 */
function makeBuilder(table: string, op: 'select' | 'insert' | 'update' | 'delete', payload?: unknown): Builder {
  const filter: Record<string, unknown> = {};
  let limit: number | null = null;
  let orderKey: string | null = null;
  let ascending = true;
  let single: 'one' | 'maybe' | null = null;
  let selectNarrow = false;

  const exec = (): { data: unknown; error: unknown } => {
    if (op !== 'select') {
      // 演示模式不写。返回一条"看起来成功"的响应，界面不会报错。
      return { data: op === 'insert' ? [{ id: `demo-${Date.now()}` }] : true, error: null };
    }
    let rows = rowsFor(table, { ...filter, select_narrow: selectNarrow });
    if (orderKey) {
      rows = [...rows].sort((a, b) => {
        const av = (a as Record<string, unknown>)[orderKey as string];
        const bv = (b as Record<string, unknown>)[orderKey as string];
        const cmp = String(av ?? '').localeCompare(String(bv ?? ''));
        return ascending ? cmp : -cmp;
      });
    }
    if (limit !== null) rows = rows.slice(0, limit);
    if (single === 'one') return { data: rows[0] ?? null, error: rows.length ? null : { code: 'PGRST116', message: 'no rows' } };
    if (single === 'maybe') return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  };

  const b: Builder = {};
  const chain = (name: string, fn: (...a: unknown[]) => void) => {
    b[name] = (...a: unknown[]) => { fn(...a); return b; };
  };

  chain('select', (cols?: unknown) => { if (typeof cols === 'string' && cols.length < 60) selectNarrow = true; });
  chain('eq', (k?: unknown, v?: unknown) => { if (typeof k === 'string') filter[k] = v; });
  for (const untouched of ['neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'not', 'or', 'filter', 'in']) {
    chain(untouched, () => { /* 演示数据不做这些过滤 */ });
  }
  chain('order', (k?: unknown, o?: unknown) => {
    if (typeof k === 'string') {
      orderKey = k;
      ascending = !(o && typeof o === 'object' && (o as { ascending?: boolean }).ascending === false);
    }
  });
  chain('limit', (n?: unknown) => { if (typeof n === 'number') limit = n; });
  for (const untouched of ['range', 'match', 'contains', 'textSearch', 'returns']) {
    chain(untouched, () => {});
  }
  chain('single', () => { single = 'one'; });
  chain('maybeSingle', () => { single = 'maybe'; });

  b.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(exec()).then(onFulfilled, onRejected);

  void payload;
  return b;
}

/** rpc 的返回值：与调用处期望的形状对齐（见 features/rpc.ts） */
function rpcResult(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'list_sessions': return DEMO_SESSIONS;
    case 'open_session': return DEMO_SESSION_ID;
    case 'create_group': return 'se-demo-new';
    case 'patch_session': return true;
    case 'mark_read': return 2;
    case 'page_messages': return DEMO_MESSAGES.map((m) => ({ ...m, session_id: DEMO_SESSION_ID, user_id: DEMO_USER.id })).reverse();
    case 'my_credit': return DEMO_CREDIT;
    case 'my_usage_days': return DEMO_TURNS.map((x) => ({ day: x.at.slice(0, 10), rounds: 12, credit: 0.42, cached_ratio: 0.88 }));
    case 'my_turns': return DEMO_TURNS.slice(0, 30);
    case 'my_usage': return DEMO_USAGE;
    case 'sticker_catalog': return DEMO_CREDIT ? [
      { token: 'hug0000001', caption: '抱抱' },
      { token: 'cry0000002', caption: '哭了' },
      { token: 'ang0000003', caption: '生气了' },
    ] : [];
    case 'add_stickers': return 3;
    case 'create_character': return 'ch-new-demo';
    case 'update_character': return 2;
    case 'publish_character': return 'pending';
    case 'add_memory': return `mm-${Date.now()}`;
    case 'delete_message': case 'delete_session': case 'delete_memory': return true;
    case 'create_share': return 'dm0a1b2c3d';
    case 'resolve_share': return {
      ok: true,
      character: { id: 'ch-shenyan', name: '沈砚', avatar: null },
      messages: DEMO_MESSAGES.slice(-6).map((m) => ({ role: m.role, content: m.content, at: m.created_at })),
    };
    case 'claim_order': return { ok: true, matched: false, note: '演示模式：不会真的查订单。' };
    case 'usage_heartbeat': return { ok: true, today_seconds: 4320, is_minor: false, fire: [] };
    case 'bump_message_count': return null;
    case 'claim_notice': return true;
    case 'label_asset': return { ok: true, asset_id: 'demo-asset', meta: { ai_generated: true, generator: 'echosoul', asset_id: 'demo-asset', label_version: 'v1' } };
    case 'my_sessions_count': return 3;
    case 'submit_guardian_request': return { ok: true, request_no: 'GR20260927AB12', response_within_days: 7, note: '演示模式。' };
    case 'guardian_status': return { ok: true, request_no: String(args.p_no ?? ''), kind: 'erase_account', status: 'received', result: '', submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    case 'export_bundle': return { ok: true, format: 'echosoul-export/1', note: '演示模式：这里只是一份占位，真实导出由服务端生成。' };
    default: return null;
  }
}

export function createDemoClient(): unknown {
  const listeners: ((e: string, s: unknown) => void)[] = [];

  const auth = {
    getSession: async () => ({ data: { session: DEMO_SESSION }, error: null }),
    getUser: async () => ({ data: { user: DEMO_USER }, error: null }),
    onAuthStateChange: (cb: (e: string, s: unknown) => void) => {
      listeners.push(cb);
      // 立刻回调一次，让外壳拿到已登录态
      setTimeout(() => cb('SIGNED_IN', DEMO_SESSION), 0);
      return { data: { subscription: { unsubscribe: () => { listeners.length = 0; } } } };
    },
    signInAnonymously: async () => ({ data: { session: DEMO_SESSION, user: DEMO_USER }, error: null }),
    signInWithOtp: async () => ({ data: {}, error: null }),
    signOut: async () => { for (const l of listeners) l('SIGNED_OUT', null); return { error: null }; },
  };

  const client = {
    auth,
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      try { return { data: rpcResult(name, args), error: null }; }
      catch (e) { return { data: null, error: { code: 'DEMO_ERROR', message: String(e) } }; }
    },
    from: (table: string) => makeBuilder(table, 'select'),
    // Edge Function 在演示模式下一律返回可读的"未接通"而不是报错
    functions: {
      invoke: async () => ({
        data: { error: 'DEMO_MODE', message: '演示模式：Edge Function 未接通。' },
        error: null,
      }),
    },
    channel: () => ({
      on: () => ({ subscribe: () => ({}) }),
      subscribe: () => ({}),
      unsubscribe: () => {},
    }),
    removeChannel: () => {},
  };

  // insert / update / delete 用同一套 builder，只是 op 不同
  (client as unknown as { from: (t: string) => unknown }).from = (table: string) => {
    const b = makeBuilder(table, 'select');
    return new Proxy(b, {
      get(target, prop: string) {
        if (prop === 'insert') return (payload: unknown) => makeBuilder(table, 'insert', payload);
        if (prop === 'update') return (payload: unknown) => makeBuilder(table, 'update', payload);
        if (prop === 'delete') return () => makeBuilder(table, 'delete');
        if (prop === 'upsert') return (payload: unknown) => makeBuilder(table, 'insert', payload);
        return (target as Record<string, unknown>)[prop];
      },
    });
  };

  void FILTER_KEYS;
  return client;
}
