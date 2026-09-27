/**
 * rpc.ts — 后端可调用的窄接口：RPC 调用 + 错误翻译
 *
 * 为什么单独一个文件：Supabase 的 PostgrestError.message 是**英文原始报错**，
 * 直接显示等于把数据库方言端给用户看（"row-level security"、"SLOT_LIMIT_4"）。
 * 本产品的用户是普通聊天用户，不是开发者。所有 RPC 出错都必须过 toMessage()。
 *
 * features/ 之间不得互相 import（分册 §1 目录纪律），所以跨 feature 要用的
 * 数据访问一律住在这里，由各方从自己目录相对引用 '../rpc'。
 *
 * 另一条规矩：服务端状态只走 TanStack Query，本文件只做"调用 + 翻译"，
 * 不持有任何缓存。
 */
import { supabase } from '../lib/supabase';

/** 带名字空间前缀的查询键；invalidate 时按前缀批量清 */
export const keys = {
  sessions: ['sessions'] as const,
  sessionMembers: (id: string) => ['session-members', id] as const,
  messages: (id: string) => ['messages', id] as const,
  memories: (characterId: string) => ['memories', characterId] as const,
  characters: ['characters'] as const,
  character: (id: string) => ['character', id] as const,
  review: (id: string) => ['card-review', id] as const,
  byok: ['byok'] as const,
  credit: ['credit'] as const,
  ledger: ['ledger'] as const,
  plans: ['plans'] as const,
  stickers: ['stickers'] as const,
  stickerCatalog: (sessionId: string) => ['sticker-catalog', sessionId] as const,
  plaza: (tag: string) => ['plaza', tag] as const,
  comments: (characterId: string) => ['comments', characterId] as const,
  shareFeed: ['share-feed'] as const,
  notifyPrefs: ['notify-prefs'] as const,
  entitlements: ['entitlements'] as const,
};

/** list_sessions 返回的行（列名与 008 的 returns table 一致） */
export interface SessionRow {
  id: string;
  kind: 'solo' | 'group';
  title: string | null;
  last_msg_at: string | null;
  pinned_at: string | null;
  archived_at: string | null;
  character_ids: string[];
  character_names: string[];
  preview: string;
  unread: number;
}

export async function listSessions(): Promise<SessionRow[]> {
  const { data, error } = await supabase.rpc('list_sessions');
  if (error) throw new Error(toMessage(error.code, error.message));
  return (data ?? []) as SessionRow[];
}

export async function openSession(characterId: string): Promise<string> {
  const { data, error } = await supabase.rpc('open_session', { p_character: characterId });
  if (error) throw new Error(toMessage(error.code, error.message));
  return String(data);
}

export async function createGroup(characterIds: string[], title?: string, carry?: number): Promise<string> {
  const { data, error } = await supabase.rpc('create_group', {
    p_character_ids: characterIds,
    ...(title !== undefined ? { p_title: title } : {}),
    ...(carry !== undefined ? { p_carry: carry } : {}),
  });
  if (error) throw new Error(toMessage(error.code, error.message));
  return String(data);
}

/** patch_session 的五个参数在服务端都是"null 表示不改"，所以这里必须显式传齐 */
export async function patchSession(p: {
  id: string; title?: string; archived?: boolean; pinned?: boolean; carry?: number;
}): Promise<boolean> {
  const { data, error } = await supabase.rpc('patch_session', {
    p_id: p.id,
    p_title: p.title ?? null,
    p_archived: p.archived ?? null,
    p_pinned: p.pinned ?? null,
    p_carry: p.carry ?? null,
  });
  if (error) throw new Error(toMessage(error.code, error.message));
  return Boolean(data);
}

export async function markRead(sessionId: string): Promise<number> {
  const { data, error } = await supabase.rpc('mark_read', { p_session: sessionId });
  if (error) throw new Error(toMessage(error.code, error.message));
  return Number(data ?? 0);
}

export interface MessageRow {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'proactive';
  character_id: string | null;
  content: string;
  partial: boolean;
  created_at: string;
}

export async function pageMessages(sessionId: string, before?: string, limit = 40): Promise<MessageRow[]> {
  const { data, error } = await supabase.rpc('page_messages', {
    p_session: sessionId,
    p_before: before ?? null,
    p_limit: limit,
  });
  if (error) throw new Error(toMessage(error.code, error.message));
  return (data ?? []) as MessageRow[];
}

export async function addMemory(characterId: string, sessionId: string | null, text: string): Promise<string> {
  const { data, error } = await supabase.rpc('add_memory', {
    p_character: characterId,
    p_session: sessionId,
    p_text: text,
  });
  if (error) throw new Error(toMessage(error.code, error.message));
  return String(data);
}

/** 受控删除入口（005）：messages / sessions / memories 都没有前端 delete 策略 */
export async function deleteViaRpc(fn: 'delete_message' | 'delete_session' | 'delete_memory', id: string): Promise<boolean> {
  const { data, error } = await supabase.rpc(fn, { p_id: id });
  if (error) throw new Error(toMessage(error.code, error.message));
  return Boolean(data);
}

export type PublishResult = 'unauthorized' | 'not_owner' | 'tier_too_low' | 'approved' | 'pending';

export async function publishCharacter(characterId: string, visibility = 'public'): Promise<PublishResult> {
  const { data, error } = await supabase.rpc('publish_character', {
    p_id: characterId,
    p_visibility: visibility,
  });
  if (error) throw new Error(toMessage(error.code, error.message));
  return (String(data ?? 'unauthorized')) as PublishResult;
}

export interface UpdateCharacterPatch {
  // 显式允许 undefined：表单字段天然是 string | undefined，
  // exactOptionalPropertyTypes 下不声明就会逼每个调用点写条件展开。
  name?: string | undefined;
  tagline?: string | undefined;
  persona?: string | undefined;
  greeting?: string | undefined;
  examples?: ExampleDialog[] | undefined;
  avatar?: string | undefined;
  portrait?: string | undefined;
  voice?: string | undefined;
  emotionPortraits?: Record<string, string> | undefined;
}

export interface ExampleDialog {
  /** 一句用户说 / 一句 TA 回，成对存 */
  user: string;
  role: string;
}

/** 返回新版本号；只改立绘/声音不会升版本（服务端只在人设变更时写版本） */
export async function updateCharacter(id: string, patch: UpdateCharacterPatch): Promise<number | null> {
  const { data, error } = await supabase.rpc('update_character', {
    p_id: id,
    p_name: patch.name ?? null,
    p_tagline: patch.tagline ?? null,
    p_persona: patch.persona ?? null,
    p_greeting: patch.greeting ?? null,
    p_examples: patch.examples === undefined ? null : JSON.stringify(patch.examples),
    p_avatar: patch.avatar ?? null,
    p_portrait: patch.portrait ?? null,
    p_voice: patch.voice ?? null,
    p_emotion_portraits: patch.emotionPortraits === undefined
      ? null
      : JSON.stringify(patch.emotionPortraits),
  });
  if (error) throw new Error(toMessage(error.code, error.message));
  return data === null || data === undefined ? null : Number(data);
}

export async function createCharacter(input: {
  name: string; tagline?: string; persona?: string; greeting?: string; examples?: ExampleDialog[];
}): Promise<string> {
  const { data, error } = await supabase.rpc('create_character', {
    p_name: input.name,
    p_tagline: input.tagline ?? '',
    p_persona: input.persona ?? '',
    p_greeting: input.greeting ?? '',
    p_examples: JSON.stringify(input.examples ?? []),
  });
  if (error) throw new Error(toMessage(error.code, error.message));
  return String(data);
}

export interface StickerInput { path: string; caption?: string }

export async function addStickers(packId: string | null, name: string, items: StickerInput[]): Promise<number> {
  const { data, error } = await supabase.rpc('add_stickers', {
    p_pack: packId,
    p_name: name,
    p_items: JSON.stringify(items),
  });
  if (error) throw new Error(toMessage(error.code, error.message));
  return Number(data ?? 0);
}

export interface StickerToken { token: string; caption: string }

export async function stickerCatalog(sessionId: string): Promise<StickerToken[]> {
  const { data, error } = await supabase.rpc('sticker_catalog', { p_session: sessionId });
  if (error) throw new Error(toMessage(error.code, error.message));
  return (data ?? []) as StickerToken[];
}

export async function createShare(sessionId: string, messageIds: string[], visibility = 'public'): Promise<string> {
  const { data, error } = await supabase.rpc('create_share', {
    p_session: sessionId,
    p_message_ids: messageIds,
    p_visibility: visibility,
  });
  if (error) throw new Error(toMessage(error.code, error.message));
  return String(data);
}

export interface ResolvedShare {
  ok: boolean;
  code?: string;
  character?: { id: string; name: string; avatar: string | null };
  messages?: { role: string; content: string; at: string }[];
}

export async function resolveShare(code: string): Promise<ResolvedShare> {
  const { data, error } = await supabase.rpc('resolve_share', { p_code: code });
  if (error) throw new Error(toMessage(error.code, error.message));
  return (data ?? { ok: false, code: 'BAD_RESPONSE' }) as ResolvedShare;
}

export interface CreditInfo {
  tier: string;
  expires_at: string | null;
  credit_expiry: string | null;
  usable: number;
  frozen: number;
  granted: number;
  spent: number;
  tts_remaining: number;
}

export async function myCredit(): Promise<CreditInfo | null> {
  const { data, error } = await supabase.rpc('my_credit');
  if (error) throw new Error(toMessage(error.code, error.message));
  return (data ?? null) as CreditInfo | null;
}

/** Edge Function 地址；实现复用 lib/supabase，避免两处拼法漂移 */
export { fnUrl, accessToken } from '../lib/supabase';

export interface ClaimResult { ok: boolean; code?: string; matched?: boolean; note?: string }

export async function claimOrder(outTradeNo: string): Promise<ClaimResult> {
  const { data, error } = await supabase.rpc('claim_order', { p_out_trade_no: outTradeNo });
  if (error) throw new Error(toMessage(error.code, error.message));
  return (data ?? { ok: false, code: 'BAD_RESPONSE' }) as ClaimResult;
}

/** 当前用户 id；未登录返回 null，交给 RLS 兜底而不是在前端猜 */
export async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

/**
 * 错误码 → 中文可懂原因。
 *
 * 覆盖三处来源：005/006/008 里 raise exception 的自定义码、PostgREST 自身的码、
 * chat Edge Function 的错误码（shared/contract/api.json 的 ErrorCode）。
 * 新增码请同时在这里加一条 —— default 分支刻意保留兜底而不抛原文，
 * 因为原文一定是英文。
 */
export function toMessage(code: string, raw?: string): string {
  switch (code) {
    case 'UNAUTHORIZED': return '登录状态过期了，重新登录一下。';
    case 'PGRST102':
    case 'PGRST202': return '这个功能的服务端还没上线，先记着，之后会补。';
    case 'PGRST301':
    case '42501': return '没有权限做这件事。如果这是你自己的内容，说明它已经被隐藏或审核未通过。';
    case 'CHARACTER_NOT_AVAILABLE': return '这个角色现在不能聊：可能已下架或没通过审核。';
    case 'NEED_TWO_MEMBERS': return '群聊至少要有两个角色。';
    case 'SESSION_NOT_FOUND': return '这个会话找不到了，刷新看看。';
    case 'NOT_OWNER': return '这不是你的内容，改不了。';
    case 'NO_MESSAGES': return '要分享的内容里没有有效消息。';
    case 'TOO_MANY': return '一次最多分享 20 条，挑几条最想给人看的就行。';
    case 'EMPTY': return '内容不能是空的。';
    case 'NAME_REQUIRED': return '先给它起个名字。';
    case 'BAD_ORDER_NO': return '订单号看起来不对：至少 8 位，请再核对一下。';
    case 'RATE_LIMITED': return '操作太快了，等一分钟再试。';
    case 'INSUFFICIENT_BALANCE': return '额度不够，先续一下。';
    case 'CONTENT_TOO_LONG': return '这段太长了，超出这个档位的单条上限。';
    case 'ENDPOINT_BLOCKED': return '这个接口地址不允许使用：不能是本机或内网地址。';
    case 'PROVIDER_CONFIG': return '服务商配置有问题，检查一下 Base URL 和模型名。';
    case 'BYOK_NOT_FOUND': return '找不到这把 Key，可能已经被删掉了。';
    case 'LEDGER_ERROR': return '记账这一步出错了，这次没有扣你的额度；稍后再试。';
    case 'UPSTREAM_5XX': return '上游模型那边出了点问题，我们没有扣你的额度。';
    case 'MODEL_STREAM_BREAK': return '说到一半断了，可以点继续。';
    case 'NETWORK': return '网络不通，检查一下连接再试。';
    default: break;
  }
  // 形如 SLOT_LIMIT_4 / GROUP_LIMIT_2 的带参码
  const m = /^(SLOT_LIMIT|GROUP_LIMIT)_(\d+)$/.exec(code);
  if (m) {
    return m[1] === 'SLOT_LIMIT'
      ? `自建角色最多 ${m[2]} 个，这个档位到顶了。`
      : `这个档位一个群最多 ${m[2]} 个角色。`;
  }
  if (/row-level security|permission denied/i.test(raw ?? '')) {
    return '这一步没被允许：可能是别人的内容，或它已经不在可见范围里。';
  }
  return '刚才没成功，再试一次。';
}
