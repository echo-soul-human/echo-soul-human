/**
 * _shared/embed.ts — embedding provider 抽象（★可用性优先）
 *
 * 存在理由：记忆抽取与召回都想要向量通道，但向量服务是**可选依赖**。
 * `memories.embedding` 可空、`recall()` 的 p_vec 可传 null、
 * `find_near_duplicate()` 只在 embedding 非空的行里找 —— 也就是说
 * 数据库侧早就为"没有向量"留了退路，这一层只需要把这条退路走通。
 *
 * 三条硬规矩：
 *   1. **未配置 ⇒ embedAvailable() 返回 false，任何调用方不得抛错**。
 *      缺 embedding 只是少一路召回，不该让抽取整批失败、更不该让对话失败。
 *   2. 维度必须与 `vector(1024)` 对齐；provider 返回别的维度就整条丢弃并计数，
 *      而不是硬塞进库里（那会让 HNSW 索引在插入时报错，拖累整批）。
 *   3. 不引入新依赖：用 fetch + WebCrypto 自己实现 RS256，
 *      Edge Runtime 里没有 npm 包可以装（docs/架构与阶段划分.md §2）。
 *
 * env：
 *   EMBEDDING_PROVIDER   openai | deepseek | <自建网关名>（决定端点形态）
 *   EMBEDDING_API_KEY    服务端 Secret，绝不下发、绝不写日志
 *   EMBEDDING_MODEL      模型名
 *   EMBEDDING_BASE_URL   可选覆盖；内置默认值未经实跑核实，见下方 TODO
 */

const DIMENSIONS = 1024; // 与 migrations/005_memory.sql 的 vector(1024) 同源，改一处必须同步另一处

export const EMBED_DIM = DIMENSIONS;

/**
 * ⚠️【必做·上线前核实】缺省端点与模型名。
 * 与 deepseek.ts 里 DEEPSEEK_MODEL_PLACEHOLDER 同样的处理方式：
 * 填错的表现是调用 4xx 而不是启动即失败，所以做成 env 可覆盖，
 * 并且失败一律降级为"没有向量"，不阻断业务。
 */
const PRESETS: Record<string, { baseUrl: string; model: string }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-large' },
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-embedding' },
};

export interface EmbedProfile {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 解析配置。任何一项缺失都返回 null —— 这是"能力探测"，不是错误。 */
export function embedProfile(): EmbedProfile | null {
  const provider = (Deno.env.get('EMBEDDING_PROVIDER') ?? '').trim().toLowerCase();
  const apiKey = (Deno.env.get('EMBEDDING_API_KEY') ?? '').trim();
  if (!provider || !apiKey) return null;

  const preset = PRESETS[provider];
  const baseUrl = (Deno.env.get('EMBEDDING_BASE_URL') ?? preset?.baseUrl ?? '').trim().replace(/\/+$/, '');
  const model = (Deno.env.get('EMBEDDING_MODEL') ?? preset?.model ?? '').trim();
  if (!baseUrl || !model) return null;

  return { provider, baseUrl, apiKey, model };
}

/** 向量通道是否可用。调用方必须能在 false 时继续工作。 */
export function embedAvailable(): boolean {
  return embedProfile() !== null;
}

export type EmbedFailure =
  | 'not-configured'   // 没配：正常降级
  | 'auth'             // Key 不对
  | 'rate-limited'     // 被限流：这批先只存文本，下次再补
  | 'model-error'      // 上游 5xx / 响应畸形
  | 'dimension'        // 返回维度与库不符
  | 'network';         // 连不上 / 超时

export interface EmbedResult {
  /** key = texts 数组下标的字符串形式（见 vectorFor）。上游给几条就是几条。 */
  vectors: Map<string, number[]>;
  /** 实际送去计算的清洗后文本，顺序与 vectors 的下标一致 */
  texts: string[];
  failed: number;
  failure: EmbedFailure | null;
}

const EMPTY: EmbedResult = { vectors: new Map(), texts: [], failed: 0, failure: 'not-configured' };

/** 与批量发送前完全一致的清洗：折叠空白 + 掐到 2000 字符。清洗后才拿去算向量。 */
export function normalizeForEmbed(text: string): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000);
}

/**
 * 从批量结果里取某段文本的向量。
 * ★ 必须走这个函数而不是自己 map.get(原文)：清洗过的文本与原文不是同一个串，
 *   直接按原文取会静默拿到 undefined ⇒ 记忆白白少了向量通道。
 */
export function vectorFor(result: EmbedResult, text: string): number[] | null {
  const idx = result.texts.indexOf(normalizeForEmbed(text));
  if (idx < 0) return null;
  return result.vectors.get(String(idx)) ?? null;
}

/**
 * 批量取向量。**永不抛错**：任何失败都变成 { vectors: 空, failure }，
 * 由调用方决定降级方式（extract worker 的选择是"只存文本"）。
 *
 * 一次 HTTP 拿一批（任务 3-5：不逐条调）。input 顺序即返回 index 顺序；
 * 上游漏给某条时只丢那一条，其余照常用。
 */
export async function embedTexts(texts: string[]): Promise<EmbedResult> {
  const profile = embedProfile();
  if (!profile) return EMPTY;

  const wanted = unique(texts.map(normalizeForEmbed).filter(Boolean));
  if (!wanted.length) return { vectors: new Map(), texts: [], failed: 0, failure: null };

  let res: Response;
  try {
    res = await fetch(`${profile.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${profile.apiKey}` },
      body: JSON.stringify({ model: profile.model, input: wanted }),
      signal: timeout(20_000),
      redirect: 'error',
    });
  } catch {
    return { vectors: new Map(), texts: wanted, failed: wanted.length, failure: 'network' };
  }

  if (!res.ok) {
    // ★ 不回读、不落日志任何上游原文：里面可能带 echo 回来的请求内容
    const code = res.status === 401 || res.status === 403 ? 'auth' : res.status === 429 ? 'rate-limited' : 'model-error';
    return { vectors: new Map(), texts: wanted, failed: wanted.length, failure: code };
  }

  let json: any;
  try {
    json = await res.json();
  } catch {
    return { vectors: new Map(), texts: wanted, failed: wanted.length, failure: 'model-error' };
  }

  const rows: any[] = Array.isArray(json?.data) ? json.data : [];
  const vectors = new Map<string, number[]>();
  for (const row of rows) {
    const index = typeof row?.index === 'number' ? row.index : -1;
    const text = index >= 0 && index < wanted.length ? wanted[index] : undefined;
    const vec = row?.embedding;
    if (!text || !Array.isArray(vec)) continue;
    if (vec.length !== DIMENSIONS || vec.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
      // 维度不符：整条丢弃。宁可少一路召回，也不要往 vector(1024) 里塞坏数据
      continue;
    }
    vectors.set(String(index), vec.map(Number));
  }

  const failure: EmbedFailure | null =
    vectors.size === 0 ? (rows.length ? 'dimension' : 'model-error') : null;
  return { vectors, texts: wanted, failed: wanted.length - vectors.size, failure };
}

/** 便捷版：只要一条的向量，拿不到就返回 null（recall 的 p_vec 允许 null） */
export async function embedOne(text: string): Promise<number[] | null> {
  const r = await embedTexts([text]);
  return vectorFor(r, text);
}

/**
 * pgvector 字面量。Supabase 的 js 客户端没有 vector 类型，
 * 传字符串即可（chat/index.ts 目前直接传 null，同一个套路）。
 */
export function toVectorLiteral(vec?: number[] | null): string | null {
  if (!vec?.length || vec.length !== DIMENSIONS) return null;
  return `[${vec.map((n) => round6(n)).join(',')}]`;
}

/** 向量数组 → 可直接写库的字面量；未配置或维度不符返回 null */
export function literalFor(result: EmbedResult, text: string): string | null {
  return toVectorLiteral(vectorFor(result, text));
}

// ─── 小工具 ──────────────────────────────────────────────
function unique(list: string[]): string[] {
  return Array.from(new Set(list));
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function timeout(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}
