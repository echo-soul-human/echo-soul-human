/**
 * _shared/providers/anthropic.ts — Anthropic Messages 协议（BYOK）
 *
 * 与 OpenAI 兼容形态的四处差异，逐条处理：
 *   1. system 是顶层参数，不是 messages[0]
 *   2. max_tokens 必填
 *   3. 流式帧有 event: 行，usage 分散在 message_start / message_delta 两处
 *   4. 提示缓存要**显式**打 cache_control（写入 1.25×、读取 0.1×）
 *      —— 对 BYOK 用户是实打实的省钱功能，默认开启
 *
 * ★ 本类必须**无状态**。provider 实例会被并发请求共享，
 *   一旦把 usage 累加器放在实例字段上，就会出现 A 用户的 token 记到 B 头上。
 *   因此 usage 分两段各自 emit，由 chat 侧按字段取最大值合并。
 */
import {
  ChatRequest,
  Provider,
  ProviderError,
  StreamEvent,
  codeFromStatus,
  estimateRequest,
  isRetryable,
  userMessageFor,
  type TokenEstimate,
} from './types.ts';
import { joinUrl, safeMessage } from './openai.ts';

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicConfig {
  baseUrl?: string;
  apiKey: string;
}

export class AnthropicProvider implements Provider {
  readonly kind = 'anthropic' as const;
  private readonly base: string;
  private readonly apiKey: string;

  constructor(cfg: AnthropicConfig) {
    this.base = cfg.baseUrl ?? ANTHROPIC_BASE_URL;
    this.apiKey = cfg.apiKey;
  }

  buildHttp(req: ChatRequest): { url: string; headers: Record<string, string>; body: unknown } {
    const useCache = req.enableProviderCache !== false;

    // 缓存断点只打在静态前缀上。前缀逐字节稳定 ⇒ 命中；
    // 一旦有人往 staticPrefix 里塞时间戳，这里写入的缓存反而白付 1.25×。
    const system = useCache
      ? [{ type: 'text', text: req.staticPrefix, cache_control: { type: 'ephemeral', ttl: '5m' } }]
      : req.staticPrefix;

    return {
      url: joinUrl(this.base, '/v1/messages'),
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        accept: 'text/event-stream',
      },
      body: {
        model: req.model,
        max_tokens: req.maxTokens, // ★ 必填，缺了直接 400
        temperature: req.temperature,
        stream: true,
        system,
        messages: req.dynamic.map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: [{ type: 'text', text: m.content }],
        })),
      },
    };
  }

  parseFrame(frame: string): StreamEvent[] {
    const data = frame
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('');
    if (!data) return [];

    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      return [];
    }

    const out: StreamEvent[] = [];

    switch (json?.type) {
      case 'message_start': {
        const u = json?.message?.usage;
        out.push({
          type: 'usage',
          usage: {
            promptTokens: num(u?.input_tokens) ?? 0,
            completionTokens: 0,
            cachedTokens: num(u?.cache_read_input_tokens) ?? 0,
            raw: { phase: 'start', input_tokens: u?.input_tokens, cache_read_input_tokens: u?.cache_read_input_tokens, cache_creation_input_tokens: u?.cache_creation_input_tokens },
          },
        });
        break;
      }

      case 'content_block_delta': {
        const text = json?.delta?.type === 'text_delta' ? json?.delta?.text : '';
        if (typeof text === 'string' && text) out.push({ type: 'delta', text });
        break;
      }

      // output_tokens 在 message_delta 里逐帧更新，取最后一次为准
      case 'message_delta': {
        const u = json?.usage;
        out.push({
          type: 'usage',
          usage: {
            promptTokens: 0,
            completionTokens: num(u?.output_tokens) ?? 0,
            cachedTokens: 0,
            raw: { phase: 'delta', output_tokens: u?.output_tokens },
          },
        });
        break;
      }

      case 'message_stop':
        out.push({ type: 'done' });
        break;

      case 'error': {
        const message = json?.error?.message;
        const over = /overloaded|rate.?limit|too many/i.test(String(message ?? ''));
        const code = over ? 'RATE_LIMITED' : 'UPSTREAM_5XX';
        out.push({
          type: 'error',
          error: {
            code,
            userMessage: userMessageFor(code),
            detail: safeMessage(message),
            retryable: isRetryable(code),
          },
        });
        break;
      }

      default:
        break; // ping / content_block_start / content_block_stop 忽略
    }

    return out;
  }

  isDoneFrame(frame: string): boolean {
    return /"type"\s*:\s*"message_stop"/.test(frame);
  }

  normalizeError(status: number | undefined, raw: unknown, err?: unknown): ProviderError {
    if (err && status === undefined) {
      const code = (err as { name?: string }).name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK';
      return { code, userMessage: userMessageFor(code), detail: safeMessage(err), retryable: isRetryable(code) };
    }
    const code = codeFromStatus(status);
    const message = (raw as any)?.error?.message ?? (raw as any)?.message;
    return {
      code,
      userMessage: userMessageFor(code),
      detail: safeMessage(message),
      retryable: isRetryable(code),
      status,
    };
  }

  estimate(req: ChatRequest): TokenEstimate {
    const e = estimateRequest(req);
    return { ...e, total: e.total + 64 }; // system 块与 content 包装的固定开销
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * 合并多段 usage：各字段取最大值。
 * 之所以取 max 而不是 sum —— Anthropic 的 message_delta 会重复上报
 * 累计的 output_tokens，sum 会翻倍；max 恰好取到最终值。
 */
export function mergeUsage(events: Array<{ promptTokens: number; completionTokens: number; cachedTokens: number }>) {
  return events.reduce(
    (a, u) => ({
      promptTokens: Math.max(a.promptTokens, u.promptTokens),
      completionTokens: Math.max(a.completionTokens, u.completionTokens),
      cachedTokens: Math.max(a.cachedTokens, u.cachedTokens),
    }),
    { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
  );
}
