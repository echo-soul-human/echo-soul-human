/**
 * StickerText.tsx — 把 `[emoji:token]` 渲染成图片
 *
 * 机制（分册-多模态 §2.2）：服务端只把 caption 列表注入 prompt（约 200-400 token），
 * 模型输出 `[emoji:笑哭]` 这类标记，前端替换成图。这样不用视觉模型、成本可控。
 *
 * ★ 最重要的一条：**未知 token 必须降级为原文，不报错、不空白**。
 *   成因很多且都正常 —— 用户删了那张贴纸但旧消息还在、包被停用、
 *   模型自己编了一个 caption、别的会话的 sticker 串过来了。
 *   任何一种情况下，"把一个词变成空洞"都比"原样留着这个词"更糟。
 *
 * 流式安全：半个标记（`[emoji:笑`）在 rAF 合并的 delta 里必然出现，
 * 这里把它当普通文本渲染，等闭合了再换图 —— 不会闪出破图。
 */
import { memo, useMemo, useState } from 'react';

export interface StickerMap {
  /** token → 图片地址；来自 sticker_catalog RPC */
  byToken: Map<string, string>;
  /** caption → 图片地址：模型经常直接写中文 caption 而不是随机 token */
  byCaption: Map<string, string>;
}

export function buildStickerMap(rows: { token: string; caption: string; path?: string }[]): StickerMap {
  const byToken = new Map<string, string>();
  const byCaption = new Map<string, string>();
  for (const r of rows) {
    if (!r.path) continue;
    byToken.set(r.token, r.path);
    if (r.caption) byCaption.set(r.caption, r.path);
  }
  return { byToken, byCaption };
}

/** 空表：目录还没加载出来时用，保证一切按原文显示 */
const EMPTY_MAP: StickerMap = { byToken: new Map(), byCaption: new Map() };

/**
 * 匹配 `[emoji:xxx]`。
 * 刻意允许中文与常见符号，因为 token 是 md5 片段而 caption 是中文，两种都要能命中。
 */
const MARK_RE = /\[emoji:([^\][\n]{1,40})\]/g;

export interface StickerTextProps {
  text: string;
  catalog?: StickerMap;
  /** 单条贴纸的显示尺寸（布局像素，非字号） */
  size?: number;
  className?: string;
}

export const StickerText = memo(function StickerText({ text, catalog, size = 56, className }: StickerTextProps) {
  const map = catalog ?? EMPTY_MAP;
  const parts = useMemo(() => splitWithStickers(text, map), [text, map]);

  return (
    <span className={`sticker-text${className ? ` ${className}` : ''}`}>
      {parts.map((p, i) => (
        p.kind === 'text'
          // 未知 token 走的就是这个分支：原样保留
          ? <span key={i}>{p.value}</span>
          : <StickerImg key={i} part={p} size={size} />
      ))}
    </span>
  );
});

/**
 * 单独一个组件只为一件事：图挂了要能退回原文。
 * 失败状态放在这里而不是父层，避免一条消息里其他贴纸被一起连坐。
 */
function StickerImg({ part, size }: { part: Extract<Part, { kind: 'sticker' }>; size: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span>{part.raw}</span>;
  return (
    <img
      className="sticker-img"
      src={part.src}
      alt={part.alt ? `表情：${part.alt}` : '表情'}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

type Part =
  | { kind: 'text'; value: string }
  | { kind: 'sticker'; src: string; alt: string; raw: string };

function splitWithStickers(text: string, map: StickerMap): Part[] {
  if (!text) return [];
  const out: Part[] = [];
  let last = 0;
  MARK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARK_RE.exec(text)) !== null) {
    const raw = m[0];
    const key = m[1] ?? '';
    const src = map.byToken.get(key) ?? map.byCaption.get(key);
    if (!src) continue;   // 未知 token：留给下面的 text 分段，等于原样输出
    if (m.index > last) out.push({ kind: 'text', value: text.slice(last, m.index) });
    out.push({ kind: 'sticker', src, alt: key, raw });
    last = m.index + raw.length;
  }
  if (last < text.length) out.push({ kind: 'text', value: text.slice(last) });
  return out;
}

/** 供 ShareImage 等需要自己排版的调用方复用同一套分割规则 */
export { splitWithStickers };
export type { Part as StickerPart };
