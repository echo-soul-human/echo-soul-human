/**
 * _shared/providers/types.ts — 模型提供方抽象
 *
 * 存在理由（docs/分册-模型与计费.md §1.2、§4.1）：
 *   内置 DeepSeek 与 BYOK 的 OpenAI 兼容 / Anthropic 三家在
 *   system 位置、流式帧格式、usage 字段名、缓存机制上全都不一样。
 *   抽象成一层，chat 主链路只面对一个接口。
 *
 * ★ 本文件同时定义了「prompt 分区契约」——静态前缀与动态段的边界，
 *   这是提示词缓存能否命中的关键。改动前必读 docs/架构与阶段划分.md §4。
 */

/** 一条内部消息。role 只在这里出现，各家映射由 provider 负责。 */
export type MsgRole = 'system' | 'user' | 'assistant';

export interface InternalMessage {
  role: MsgRole;
  content: string;
}

/**
 * 已按分区拼好的请求。
 *
 * staticPrefix 与 dynamic 的分离是**强制**的：
 *   staticPrefix —— A(平台锁) + B(角色锁) + C(阶段段)，必须逐字节稳定
 *   dynamic      —— D(RAG 召回) + E(携带历史) + F(本轮输入)
 *
 * provider 实现不得把 dynamic 的内容插到 staticPrefix 之前，
 * 也不得往 staticPrefix 里追加任何随时间/用户变化的值。
 */
export interface ChatRequest {
  staticPrefix: string;
  dynamic: InternalMessage[];
  model: string;
  maxTokens: number;
  temperature: number;
  /** Anthropic 显式缓存开关；其他 provider 忽略 */
  enableProviderCache?: boolean;
  signal?: AbortSignal;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /** 命中缓存的输入 token。拿不到就填 0，但必须显式填。 */
  cachedTokens: number;
  /** provider 原始 usage，落库存档 */
  raw?: unknown;
}

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'error'; error: ProviderError }
  | { type: 'done' };

/** 归一后的错误。code 直接对应 docs/架构与阶段划分.md §2.1 的错误码表。 */
export type ProviderErrorCode =
  | 'RATE_LIMITED'
  | 'AUTH_FAILED'
  | 'BAD_REQUEST'
  | 'UPSTREAM_5XX'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'UNKNOWN';

export interface ProviderError {
  code: ProviderErrorCode;
  /** 给用户看的中文说明（不暴露原始英文错误） */
  userMessage: string;
  /** 给日志用的安全信息：不含 Key、不含完整请求体 */
  detail?: string;
  retryable: boolean;
  status?: number;
}

export interface TokenEstimate {
  promptTokens: number;
  completionTokens: number;
  total: number;
}

export interface Provider {
  readonly kind: 'deepseek' | 'openai' | 'anthropic';
  /** 把分区请求转成对上游的实际 HTTP 调用参数 */
  buildHttp(req: ChatRequest): { url: string; headers: Record<string, string>; body: unknown };
  /** 解析一个 SSE 帧（已按空行切帧、已去掉前导 'data:' 的内容由实现自取） */
  parseFrame(rawFrame: string): StreamEvent[];
  /** 该 provider 是否有明确的结束标志帧 */
  isDoneFrame?(rawFrame: string): boolean;
  normalizeError(status: number | undefined, raw: unknown, err?: unknown): ProviderError;
  /** 预冻结用的上限估算 */
  estimate(req: ChatRequest): TokenEstimate;
}

// ─── 通用工具 ────────────────────────────────────────────

/**
 * 粗估 token 数，仅用于预冻结上限，**不用于计费**。
 * 中文约 1 字 ≈ 1 token，英文约 4 字符 ≈ 1 token，取偏保守的系数。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[㐀-一-鿿豈-﫿-ヿ가-]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 1.1 + other / 3.2);
}

export function estimateRequest(req: ChatRequest): TokenEstimate {
  const prompt =
    estimateTokens(req.staticPrefix) +
    req.dynamic.reduce((n, m) => n + estimateTokens(m.content) + 8, 0);
  return {
    promptTokens: prompt,
    completionTokens: req.maxTokens,
    total: prompt + req.maxTokens,
  };
}

/** 把各家 SSE 原始块切成帧（以空行分帧），返回未处理的残包。 */
export function splitSseFrames(buffer: string): { frames: string[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  return { frames: parts.filter((p) => p.trim().length > 0), rest };
}

/** 从一帧里取出所有 data: 行的内容并拼接 */
export function dataLinesOf(frame: string): string {
  return frame
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trimStart())
    .join('\n');
}

/** 统一的状态码 → 错误码映射（各家共用部分） */
export function codeFromStatus(status: number | undefined): ProviderErrorCode {
  switch (status) {
    case 401:
    case 403:
      return 'AUTH_FAILED';
    case 400:
    case 404:
    case 422:
      return 'BAD_REQUEST';
    case 408:
      return 'TIMEOUT';
    case 429:
      return 'RATE_LIMITED';
    default:
      if (status && status >= 500) return 'UPSTREAM_5XX';
      return 'UNKNOWN';
  }
}

/** 用户可见的中文说明。原则：说清是谁的问题、用户能做什么。 */
export function userMessageFor(code: ProviderErrorCode): string {
  switch (code) {
    case 'RATE_LIMITED':
      return '这会儿有点挤，正在重试。';
    case 'AUTH_FAILED':
      return '你的 Key 好像不能用了，去设置里检查一下。';
    case 'BAD_REQUEST':
      return '这次请求没发出去，可能是配置里的模型名不对。';
    case 'UPSTREAM_5XX':
      return '模型那边出了点问题，已经为你退回本轮费用。';
    case 'TIMEOUT':
      return '等得有点久，正在重试。';
    case 'NETWORK':
      return '网络不通，检查一下连接再试。';
    default:
      return '刚才没成功，已经为你退回本轮费用。';
  }
}

export function isRetryable(code: ProviderErrorCode): boolean {
  return code === 'RATE_LIMITED' || code === 'TIMEOUT' || code === 'UPSTREAM_5XX' || code === 'NETWORK';
}
