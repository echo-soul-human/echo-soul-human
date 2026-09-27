/**
 * _shared/providers/index.ts — provider 工厂
 *
 * A2/A3 定案：内置只有 DeepSeek；BYOK 支持 OpenAI 兼容 + Anthropic。
 * 新增协议只改这一个文件，chat 主链路不动。
 */
import type { Provider } from './types.ts';
import { DeepSeekProvider, DEEPSEEK_MODEL_PLACEHOLDER } from './deepseek.ts';
import { OpenAIProvider } from './openai.ts';
import { AnthropicProvider } from './anthropic.ts';

export type ProviderKind = 'deepseek' | 'openai' | 'anthropic';

export interface ResolvedProfile {
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  extraBody?: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
}

export const BUILTIN_MODEL: string =
  Deno.env.get('DEEPSEEK_MODEL') ?? DEEPSEEK_MODEL_PLACEHOLDER;

export function createProvider(p: ResolvedProfile): Provider {
  switch (p.kind) {
    case 'deepseek':
      return new DeepSeekProvider({ apiKey: p.apiKey, baseUrl: p.baseUrl });
    case 'anthropic':
      return new AnthropicProvider({ apiKey: p.apiKey, baseUrl: p.baseUrl });
    case 'openai':
    default:
      return new OpenAIProvider({
        apiKey: p.apiKey,
        baseUrl: p.baseUrl,
        extraBody: p.extraBody,
        extraHeaders: p.extraHeaders,
      });
  }
}

/** 内置链路的固定 profile：Key 只从 Secrets 读，绝不下发（G1 定案） */
export function builtinProfile(): ResolvedProfile {
  const apiKey = Deno.env.get('DEEPSEEK_API_KEY');
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not configured');
  return {
    kind: 'deepseek',
    baseUrl: Deno.env.get('DEEPSEEK_BASE_URL') ?? 'https://api.deepseek.com',
    apiKey,
    model: BUILTIN_MODEL,
  };
}

export * from './types.ts';
export { mergeUsage } from './anthropic.ts';
export { normalizeUsage, safeMessage } from './openai.ts';
