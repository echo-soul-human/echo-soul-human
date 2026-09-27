/**
 * _shared/providers/deepseek.ts — 内置模型（A2 定案：只此一家）
 *
 * DeepSeek 走 OpenAI 兼容协议，但有两点必须单独处理：
 *   1. usage 里的缓存命中字段是 prompt_cache_hit_tokens（非 OpenAI 标准名）
 *   2. 上下文缓存是**自动前缀匹配**，不需要也不能显式声明
 *      —— 这正是 docs/分册-模型与计费.md §2 那套「静态前缀」规范存在的原因
 */
import { OpenAIProvider, type OpenAIConfig } from './openai.ts';
import type { ChatRequest, TokenEstimate } from './types.ts';
import { estimateRequest } from './types.ts';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

/**
 * ⚠️ 【必做·上线前核实】模型名字符串。
 * 用户定案是「DeepSeek Flash 一档，后续只跟最新 Flash 类模型」。
 * DeepSeek 实际的 model 取值历史上是 'deepseek-chat' / 'deepseek-reasoner'，
 * "Flash" 是品类描述而非 API 值。**这里必须填官方控制台里的准确字符串**，
 * 填错的表现是 400 BAD_REQUEST，而不是启动即失败，很容易漏。
 *
 * 因此做成可配置：env DEEPSEEK_MODEL 覆盖，缺省值仅作为待核实的占位。
 */
export const DEEPSEEK_MODEL_PLACEHOLDER = 'deepseek-chat';

export interface DeepSeekConfig extends Omit<OpenAIConfig, 'baseUrl'> {
  baseUrl?: string;
}

/**
 * DeepSeek 不支持 Anthropic 那种显式 cache_control，缓存完全依赖
 * 「前缀逐字节一致」。因此本类**刻意不重写 buildHttp**：
 * 复用 OpenAI 的分区组装，前缀原样进 messages[0].system。
 *
 * 任何往 staticPrefix 里塞动态值的改动都会静默击穿缓存（贵 3.2 倍且不报错），
 * 由 scripts/check-prefix.mjs 在 CI 拦截。
 */
export class DeepSeekProvider extends OpenAIProvider {
  override readonly kind = 'deepseek' as const;

  constructor(cfg: DeepSeekConfig) {
    super({ ...cfg, baseUrl: cfg.baseUrl ?? DEEPSEEK_BASE_URL });
  }

  override estimate(req: ChatRequest): TokenEstimate {
    const e = estimateRequest(req);
    // 上限估算按 1.15 冗余：中文分词与 tool 定义可能多算，宁可多冻一点再退
    return {
      promptTokens: Math.ceil(e.promptTokens * 1.15),
      completionTokens: e.completionTokens,
      total: Math.ceil(e.promptTokens * 1.15) + e.completionTokens,
    };
  }
}

/** 从环境变量构造内置 provider；Key 只存在于服务端 Secrets（G1 定案） */
export function deepSeekFromEnv(): DeepSeekProvider {
  const apiKey = Deno.env.get('DEEPSEEK_API_KEY');
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not configured');
  return new DeepSeekProvider({ apiKey });
}

/** 内置模型名同样从 env 读，避免和 provider 配置耦合 */
export function deepSeekModel(): string {
  return Deno.env.get('DEEPSEEK_MODEL') ?? DEEPSEEK_MODEL_PLACEHOLDER;
}
