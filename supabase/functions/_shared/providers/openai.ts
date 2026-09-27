/**
 * _shared/providers/openai.ts — OpenAI 兼容协议
 *
 * 覆盖：OpenAI、豆包、Kimi、通义、OpenRouter、本地 Ollama/vLLM 等
 * 凡是实现 /v1/chat/completions 标准形态的端点。
 *
 * 不做逐家特化（docs/分册-模型与计费.md §4.2）：只保证标准协议，
 * 差异靠「自定义字段透传」高级面板解决。
 */
import {
  ChatRequest,
  InternalMessage,
  Provider,
  ProviderError,
  StreamEvent,
  Usage,
  codeFromStatus,
  dataLinesOf,
  estimateRequest,
  isRetryable,
  userMessageFor,
} from './types.ts';

export interface OpenAIConfig {
  baseUrl: string;
  apiKey: string;
  /** 额外透传到请求体的字段（BYOK 高级面板用） */
  extraBody?: Record<string, unknown>;
  /** 自定义请求头（部分网关要求） */
  extraHeaders?: Record<string, string>;
}

export class OpenAIProvider implements Provider {
  readonly kind = 'openai' as const;

  constructor(protected cfg: OpenAIConfig) {}

  buildHttp(req: ChatRequest): { url: string; headers: Record<string, string>; body: unknown } {
    // ★ 顺序契约：staticPrefix 必须是 messages[0] 的 system，且逐字节稳定。
    //   任何把动态值拼进这里的做法都会击穿上游的自动前缀缓存。
    const messages: InternalMessage[] = [
      { role: 'system', content: req.staticPrefix },
      ...req.dynamic,
    ];

    return {
      url: joinUrl(this.cfg.baseUrl, '/chat/completions'),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.apiKey}`,
        accept: 'text/event-stream',
        ...this.cfg.extraHeaders,
      },
      body: {
        model: req.model,
        messages,
        stream: true,
        // 绝大多数兼容网关支持；不支持的会在 usage 里缺字段，由 chat 侧兜底估算
        stream_options: { include_usage: true },
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        ...this.cfg.extraBody,
      },
    };
  }

  parseFrame(frame: string): StreamEvent[] {
    const data = dataLinesOf(frame);
    if (!data || data === '[DONE]') return [{ type: 'done' }];

    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      return []; // 半帧或心跳注释，忽略
    }

    const out: StreamEvent[] = [];

    const delta = json?.choices?.[0]?.delta;
    const text = typeof delta?.content === 'string' ? delta.content : '';
    if (text) out.push({ type: 'delta', text });

    const usage = normalizeUsage(json?.usage);
    if (usage) out.push({ type: 'usage', usage });

    if (json?.error) out.push({ type: 'error', error: this.streamError(json.error) });

    return out;
  }

  isDoneFrame(frame: string): boolean {
    return dataLinesOf(frame) === '[DONE]';
  }

  normalizeError(status: number | undefined, raw: unknown, err?: unknown): ProviderError {
    if (err && status === undefined) {
      const code = (err as { name?: string }).name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK';
      return {
        code,
        userMessage: userMessageFor(code),
        detail: safeMessage(err),
        retryable: isRetryable(code),
      };
    }

    const code = codeFromStatus(status);
    return {
      code,
      userMessage: userMessageFor(code),
      // 只留 provider/message，绝不记录 authorization 与完整 body
      detail: safeMessage(pickError(raw, 'message') ?? pickError(raw, 'code')),
      retryable: isRetryable(code),
      status,
    };
  }

  estimate(req: ChatRequest) {
    return estimateRequest(req);
  }

  /** 流内 error 帧：上游在 200 响应里返回的业务错误 */
  protected streamError(raw: unknown): ProviderError {
    const message = pickError(raw, 'message');
    const rateish = /rate.?limit|too many requests|429|concurrency/i.test(message ?? '');
    const code = rateish ? 'RATE_LIMITED' : 'UPSTREAM_5XX';
    return {
      code,
      userMessage: userMessageFor(code),
      detail: safeMessage(message),
      retryable: isRetryable(code),
    };
  }
}

// ─── 工具 ────────────────────────────────────────────────

export function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  const p = path.replace(/^\/+/, '');
  return `${b}/${p}`;
}

/**
 * usage 归一。各家字段名不一致，且 DeepSeek 额外提供缓存命中字段。
 * cachedTokens 拿不到就填 0——但必须显式填，否则成本看板会静默失真。
 */
export function normalizeUsage(u: any): Usage | null {
  if (!u) return null;
  const prompt = num(u.prompt_tokens) ?? num(u.input_tokens) ?? num(u.promptTokens);
  const completion = num(u.completion_tokens) ?? num(u.output_tokens) ?? num(u.completionTokens);
  if (prompt === null && completion === null) return null;

  const cached =
    num(u.prompt_cache_hit_tokens) ??                    // DeepSeek
    num(u.prompt_tokens_details?.cached_tokens) ??       // OpenAI 标准
    num(u.cached_tokens) ??                              // 部分网关
    0;

  return {
    promptTokens: prompt ?? 0,
    completionTokens: completion ?? 0,
    cachedTokens: cached,
    raw: u,
  };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function pickError(raw: unknown, key: 'message' | 'code'): string | undefined {
  const r = raw as any;
  const v = r?.error?.[key] ?? r?.[key];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
}

/** 日志安全：截断 + 去掉任何像 Key 的串 */
export function safeMessage(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
  return s
    .replace(/(sk-|Bearer\s+)[A-Za-z0-9_\-]{6,}/gi, '$1****')
    .slice(0, 400);
}
