/**
 * _shared/prefix.ts — 静态前缀组装（★成本关键路径）
 *
 * 这里产出的字符串是 DeepSeek 自动前缀缓存的命中对象。
 * 规则只有一条：**逐字节稳定**。
 *
 *   命中 ⇒ 单轮成本 ≈ ¥0.0035
 *   击穿 ⇒ 单轮成本 ≈ ¥0.0112（贵 3.2 倍，且不报错、只悄悄亏钱）
 *
 * 因此本文件：
 *   · 只接受白名单占位符，且其值必须"按角色 + 阶段冻结"，不得随时间/用户变化
 *   · 拒绝任何未替换的占位符（宁可抛错，也不要产出一个"看着正常但击穿缓存"的前缀）
 *   · 把动态内容（时间、余额、用户名、RAG 片段）留给调用方放进 dynamic 段
 *
 * 见 docs/分册-模型与计费.md §2、docs/架构与阶段划分.md §4
 */

// 由 scripts/gen-prefix-module.mjs 从 _shared/prefix/*.md 生成。
// 生成物带 sha256，check-prefix.mjs 用它做击穿防线。
import { PLATFORM_LOCK, ROLE_LOCK_TPL, PREFIX_HASH } from './prefix.generated.ts';

export { PLATFORM_LOCK, PREFIX_HASH };

/** 关系阶段 → 阶段描述。枚举固定，一天最多变一次，缓存友好。 */
const STAGE_FORMS: Record<string, { label: string; posture: string; note: string }> = {
  stranger:    { label: '刚认识',   posture: '客气、有距离感',       note: '还不熟悉，不要主动用亲昵称呼。' },
  acquainted:  { label: '熟悉了',   posture: '自然、会主动搭话',     note: '可以提起之前聊过的事。' },
  close:       { label: '关系很近', posture: '放松、会开玩笑也会认真', note: '允许表达想念，允许闹小脾气。' },
  ambiguous:   { label: '暧昧',     posture: '有张力、会留白',       note: '点到为止，不摊牌也不后退。' },
  established: { label: '已确立关系', posture: '自然、笃定',         note: '把对方当作理所当然的一部分。' },
};

export const STAGES = Object.keys(STAGE_FORMS);

/** 白名单占位符。新增 = 可能击穿缓存，必须走 prefix-break 评审。 */
export const ALLOWED_PLACEHOLDERS = [
  'CHAR_NAME', 'TAGLINE', 'PERSONA', 'EXAMPLE_DIALOGS',
  'BEHAVIOR_NOTES', 'STAGE_FORMS', 'ANTI_DRIFT_REPLY', 'CHARACTER_BOUNDARIES',
] as const;

export interface PrefixInput {
  name: string;
  tagline: string;
  persona: string;
  exampleDialogs: unknown; // jsonb 数组
  behaviorNotes: string;
  antiDriftReply: string;
  boundaries: string;
  stage: string;
}

/**
 * 单值清洗：折叠空白、掐控制字符、按固定上限截断。
 * 截断上限必须固定 —— 否则同一段文本在不同时刻会渲染出不同长度，前缀就变了。
 */
function norm(s: unknown, max = 6000): string {
  return String(s ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

function renderExamples(v: unknown): string {
  if (!Array.isArray(v) || v.length === 0) return '（无示例，按人设描述说话）';
  return v
    .slice(0, 12) // 固定上限，避免长度漂移
    .map((pair: any) => {
      const user = norm(pair?.user ?? pair?.[0], 400);
      const role = norm(pair?.role ?? pair?.assistant ?? pair?.[1], 400);
      if (!user && !role) return '';
      return `用户：${user}\n${role}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

function renderStageForms(stage: string): string {
  const s = STAGE_FORMS[stage] ?? STAGE_FORMS.stranger;
  return `当前关系：${s.label}。说话姿态：${s.posture}。${s.note}`;
}

function valuesFor(input: PrefixInput): Record<string, string> {
  return {
    CHAR_NAME: norm(input.name, 120),
    TAGLINE: norm(input.tagline, 300),
    PERSONA: norm(input.persona),
    EXAMPLE_DIALOGS: norm(renderExamples(input.exampleDialogs)),
    BEHAVIOR_NOTES: norm(input.behaviorNotes, 2000),
    STAGE_FORMS: renderStageForms(input.stage),
    ANTI_DRIFT_REPLY: norm(input.antiDriftReply, 600),
    CHARACTER_BOUNDARIES: norm(input.boundaries, 1200),
  };
}

/**
 * 组装静态前缀 = A(平台锁) + B(角色锁，含 C 阶段段)。
 *
 * @throws 若模板里存在白名单外的占位符，或未全部替换 —— 直接抛错，
 *         因为"带着未替换占位符的前缀"会每轮都不同，等于静默击穿缓存。
 */
export function buildStaticPrefix(input: PrefixInput): string {
  const values = valuesFor(input);

  const roleLock = ROLE_LOCK_TPL.replace(
    /\{\{([A-Z_]+)\}\}/g,
    (whole: string, key: string) => {
      if (!(key in values)) {
        throw new Error(
          `prefix: 未知占位符 ${whole}。新增占位符会击穿提示词缓存，` +
            `必须走 scripts/check-prefix.mjs --update 与成本评审。`,
        );
      }
      return values[key];
    },
  );

  const leftover = roleLock.match(/\{\{[A-Z_]+\}\}/);
  if (leftover) {
    throw new Error(`prefix: 存在未替换的占位符 ${leftover[0]}，拒绝发送`);
  }

  // 两段之间用固定分隔符连接，不引入任何变化量
  return `${PLATFORM_LOCK}\n\n${roleLock.trim()}\n`;
}

/**
 * 前缀指纹。落库到 character_locks.static_hash，
 * 用于「人设被改了但锁没同步」的检测，也是 check-prefix 的运行时对端。
 */
export async function fingerprint(input: PrefixInput): Promise<string> {
  const text = buildStaticPrefix(input);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 动态段拼装 —— 所有会变的東西只能进这里。
 *
 * 顺序：D(RAG 召回) → E(携带历史) → F(本轮输入 + 时间 + 余额)
 * 时间戳与余额必须在**最后一条**，否则击穿缓存。
 */
export interface DynamicPart {
  recalled: Array<{ text: string; kind: string }>;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  userContent: string;
  /** 仅用于最后一条消息的提示，不进前缀 */
  balanceHint?: string;
  stickerCaptions?: string[];
}

export function buildDynamicParts(p: DynamicPart) {
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  if (p.recalled.length) {
    messages.push({
      role: 'user',
      content:
        '<memory>\n' +
        p.recalled.map((r) => `- (${r.kind}) ${r.text}`).join('\n') +
        '\n</memory>\n这些是你记得的事，自然地用，不要逐条复述。',
    });
  }

  for (const h of p.history) messages.push({ role: h.role, content: h.content });

  const tail: string[] = [];
  if (p.stickerCaptions?.length) {
    tail.push(`可用表情（要发就用 [emoji:标识]，单独一行）：${p.stickerCaptions.join('、')}`);
  }
  if (p.balanceHint) tail.push(p.balanceHint);

  messages.push({
    role: 'user',
    content: tail.length
      ? `${tail.join('\n')}\n\n${p.userContent}`
      : p.userContent,
  });

  return messages;
}
