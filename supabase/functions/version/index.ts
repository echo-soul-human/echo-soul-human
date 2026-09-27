/**
 * functions/version — 版本清单（网页与安卓共用一个接口）
 *
 * 契约见 docs/架构与阶段划分.md §2.7。三条约束决定了这个函数的写法：
 *   1. **必须 no-store** —— CDN 缓存会让轮询拿到旧值，反而误报"有新版本"，
 *      用户点了刷新其实什么都没更新（docs/分册-网页端.md §6.3）。
 *   2. **不鉴权、不写日志正文** —— 这是公开信息；但也不放任何内部字段出去。
 *   3. **读不到说明就返回 null，绝不抛错** —— 更新弹窗的优先级高于文案，
 *      拿不到"更新了什么"也要能提示"有新版本"。
 *
 * 版本号真源是仓库根 manifest.json（禁止在别处手写版本号），
 * APK 的 url / sha256 / size 由发布流水线写进 version_overrides.json，
 * 本函数只负责合并 + 兜底成合法 JSON。
 */
import { preflight, safe } from '../_shared/http.ts';

const HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'content-type': 'application/json; charset=utf-8',
  // ★ 唯一正确的缓存策略：每次都要现问服务端
  'cache-control': 'no-store, max-age=0',
  'pragma': 'no-cache',
};

interface Manifest {
  product?: { name?: string; codeName?: string; slug?: string };
  web?: { build?: string; force_refresh?: boolean; base_path?: string };
  android?: { version_name?: string; version_code?: number; min_version_code?: number };
  release_notes_file?: string;
}

interface Overrides {
  android?: { url?: string; sha256?: string; size?: number; version_name?: string; version_code?: number; min_version_code?: number };
  web?: { build?: string; force_refresh?: boolean };
}

const FALLBACK_NOTES_SOURCES = ['release-notes.json', 'RELEASE_NOTES.md'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }), { status: 405, headers: HEADERS });
  }

  const [manifest, overrides, notes] = await Promise.all([
    readJson<Manifest>('manifest.json'),
    readJson<Overrides>('version_overrides.json'),
    loadNotes(),
  ]);

  const webBuild = pickStr(overrides?.web?.build, manifest?.web?.build) ?? null;
  const android = mergeAndroid(manifest, overrides);

  const payload = {
    web: {
      build: webBuild,
      force_refresh: Boolean(overrides?.web?.force_refresh ?? manifest?.web?.force_refresh ?? false),
      notes,
    },
    android,
    generated_at: new Date().toISOString(),
  };

  return new Response(JSON.stringify(payload), { headers: HEADERS });
});

// ─── notes ───────────────────────────────────────────────
interface NotesOut { version: string | null; date: string | null; items: string[] }

/**
 * 依次尝试三个来源：CI 产出的 release-notes.json（已结构化）、
 * 站点上的 RELEASE_NOTES.md（现场解析）、仓库同名文件。
 * 全都没有 ⇒ null。这里任何一步失败都只是往下走，不抛。
 */
async function loadNotes(): Promise<NotesOut | null> {
  const json = await readJson<{ version?: string; build?: string; items?: unknown }>('release-notes.json');
  if (json && typeof json === 'object' && Array.isArray(json.items) && json.items.length) {
    return { version: pickStr(json.version, null), date: null, items: json.items.map(String).slice(0, 20) };
  }

  for (const file of [...new Set(FALLBACK_NOTES_SOURCES)]) {
    const md = await readText(file);
    if (!md) continue;
    const parsed = parseReleaseNotes(md);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * 与 scripts/release-notes.mjs 同源的解析规则（约定见 RELEASE_NOTES.md 头部）：
 *   `## <版本号> · <日期>` 开头，条目以 `- ` 起头，`---` 之后不属于本段。
 * 为什么在这里重写一份而不是 import .mjs：Edge Runtime 不能依赖仓库根的
 * Node 脚本，而这份格式约定的代码量小且被测试覆盖（notes 为空即降级 null）。
 */
function parseReleaseNotes(md: string): NotesOut | null {
  const out: NotesOut[] = [];
  let cur: NotesOut | null = null;
  let inComment = false;

  for (const line of md.split(/\r?\n/)) {
    if (line.trim() === '<!--') inComment = true;
    if (inComment) {
      if (line.trim() === '-->') inComment = false;
      continue;
    }
    const head = /^##\s+(\S+)\s*·\s*(.+?)\s*$/.exec(line);
    if (head) {
      cur = { version: head[1], date: head[2].trim(), items: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (/^##\s/.test(line) || /^---+\s*$/.test(line)) { cur = null; continue; }
    const item = /^-\s+(.*)$/.exec(line);
    if (item && item[1].trim()) cur.items.push(item[1].trim());
  }

  return out.find((s) => s.items.length > 0) ?? null;
}

// ─── android ─────────────────────────────────────────────
function mergeAndroid(manifest: Manifest | null, overrides: Overrides | null) {
  const m = manifest && typeof manifest.android === 'object' && manifest.android ? manifest.android : {};
  const o = overrides && typeof overrides.android === 'object' && overrides.android ? overrides.android : {};
  const versionName = pickStr(o.version_name, m.version_name) ?? null;
  const versionCode = pickNum(o.version_code, m.version_code) ?? null;
  return {
    version_name: versionName,
    version_code: versionCode,
    // 没发布过 APK 时这三个字段就是 null：安卓侧据此判定"无可用更新"，
    // 而不是拿空串去下载然后 SHA256 校验失败
    url: pickStr(o.url, null),
    sha256: pickStr(o.sha256, null),
    size: pickNum(o.size, null),
    min_version_code: pickNum(o.min_version_code, m.min_version_code) ?? versionCode,
  };
}

// ─── 读取（全部静默降级）────────────────────────────────
function publicBaseUrl(): string | null {
  const raw = Deno.env.get('SITE_URL') ?? Deno.env.get('PUBLIC_BASE_URL') ?? null;
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

async function readJson<T>(file: string): Promise<T | null> {
  const text = await readText(file);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    // 只认对象：数组 / 字符串 / 数字都当读不到，免得下游点属性时抛
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

async function readText(file: string): Promise<string | null> {
  return (await readLocal(file)) ?? (await readRemote(file));
}

/**
 * 首选：直接读部署包里的文件。
 * `supabase functions deploy` 会把函数目录带上去，但落到运行时的深度不固定，
 * 所以从本模块往上逐层找，找到就算；全找不到再走 HTTP 兜底。
 * 比绕一圈 HTTP 更可靠（不依赖 SITE_URL，也不受站点发布时序影响）。
 */
const SEARCH_UP_TO = 5;

async function readLocal(file: string): Promise<string | null> {
  for (let depth = 2; depth <= SEARCH_UP_TO + 1; depth++) {
    try {
      // file 只来自本文件的常量表，不含任何请求输入
      const url = new URL(`${'../'.repeat(depth)}${file}`, import.meta.url);
      if (url.protocol !== 'file:') return null;
      const text = await Deno.readTextFile(url);
      if (text && text.length <= 200_000) return text;
    } catch {
      /* 这一层没有，继续往上找 */
    }
  }
  return null;   // 读不到是常态（没随包带上），不是错误
}

/** 兜底：从站点根读。需要 SITE_URL / PUBLIC_BASE_URL；没配就跳过 */
async function readRemote(file: string): Promise<string | null> {
  const base = publicBaseUrl();
  if (!base) return null;
  try {
    const res = await fetch(`${base}/${file}`, { redirect: 'error' });
    if (!res.ok) return null;
    const text = await res.text();
    return text.length > 200_000 ? null : text;
  } catch (e) {
    console.warn('[version] remote read failed', file, safe(e));
    return null;
  }
}

function pickStr(a: unknown, b: unknown): string | null {
  if (typeof a === 'string' && a) return a;
  if (typeof b === 'string' && b) return b;
  return null;
}

function pickNum(a: unknown, b: unknown): number | null {
  const n1 = typeof a === 'number' ? a : Number(a);
  if (Number.isFinite(n1) && n1 > 0) return Math.trunc(n1);
  const n2 = typeof b === 'number' ? b : Number(b);
  if (Number.isFinite(n2) && n2 > 0) return Math.trunc(n2);
  return null;
}
