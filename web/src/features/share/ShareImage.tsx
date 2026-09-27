/**
 * ShareImage.tsx — 选消息 → 生成分享图
 *
 * 增长 §4：这是抖音转化链路的入口素材。三条不可退让的规矩：
 *   1. **默认脱敏**：昵称换成"某人"、头像不出现（角色名保留 —— 那才是内容本身）。
 *      用户要主动取消勾选才会带上自己的名字，且勾上时再提示一次。
 *   2. **"内容由 AI 生成"小标识强制保留**（29 号专篇）：本地 canvas 路径也画进像素里，
 *      所以即使图片被转存、截图，标识仍在 —— CSS overlay 会被截掉，画进 canvas 不会。
 *   3. 发布前明示将被公开的具体内容 —— 本组件在导出前先给一张预览，
 *      并列出"这几条原话会出现在图上"。
 *
 * 渲染优先级：服务端出图（一致性好、可控字体）→ 失败回落本地 canvas。
 * ⚠ 长图模式高度不定，必须按行数预估高度，否则 iOS 上生成过程会跳。
 */
import { useCallback, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { accessToken, fnUrl } from '../../lib/supabase';
import { TOKENS } from '../../app/tokens.generated';
import { createShare, type MessageRow } from '../rpc';
import { buildStickerMap, splitWithStickers } from '../chat/StickerText';
import { Sheet } from '../../ui/Sheet';
import { toast } from '../../ui/Toast';
import { IconDownload, IconEye, IconShare, IconWarning } from '../../ui/icons';

type Ratio = '3:4' | '9:16' | '1:1' | 'long';

const RATIOS: { key: Ratio; label: string; w: number; h: number | null; note: string }[] = [
  { key: '3:4', label: '3:4', w: 1080, h: 1440, note: '抖音图文' },
  { key: '9:16', label: '9:16', w: 1080, h: 1920, note: '故事 / 竖屏' },
  { key: '1:1', label: '1:1', w: 1080, h: 1080, note: '方形，转发不变形' },
  { key: 'long', label: '长图', w: 900, h: null, note: '整段都在一张上' },
];

export interface ShareImageProps {
  sessionId: string;
  characterName: string;
  messages: MessageRow[];
  /** 已选中的消息 id */
  selectedIds: string[];
  onClose: () => void;
}

export function ShareImage({ sessionId, characterName, messages, selectedIds, onClose }: ShareImageProps) {
  const [ratio, setRatio] = useState<Ratio>('3:4');
  const [revealName, setRevealName] = useState(false);
  const [nickname, setNickname] = useState('');
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [serverFailed, setServerFailed] = useState(false);

  const picked = useMemo(
    () => messages.filter((m) => selectedIds.includes(m.id)),
    [messages, selectedIds],
  );

  // 分享图里不画表情图片：外部图绘进 canvas 会污染画布导致导出失败，
  // 所以 map 永远是空的 —— splitWithStickers 会把 [emoji:x] 降级成 [x] 文本。
  const map = useMemo(() => buildStickerMap([]), []);

  const anonName = useCallback((role: MessageRow['role']) => {
    if (role === 'user') return revealName && nickname ? nickname : '某人';
    return characterName;
  }, [revealName, nickname, characterName]);

  const generate = useCallback(async () => {
    if (!picked.length) { toast.warn('先勾几条再出图'); return; }
    setBusy(true);
    setDataUrl(null);
    try {
      // ① 服务端优先：字体与配色由我们控制，跨设备一致
      const token = await accessToken();
      const res = await fetch(`${fnUrl('share-image')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          session_id: sessionId,
          message_ids: picked.map((m) => m.id),
          ratio,
          anonymize: !revealName,
          display_name: revealName ? nickname : null,
          character_name: characterName,
        }),
      });
      if (res.ok) {
        const j = await res.json() as { url?: string };
        if (j.url) { setDataUrl(j.url); setBusy(false); return; }
      }
      // ② 本地兜底：功能不能因为一个没上的接口就整个不能用
      const local = await drawLocal(picked, ratio, map, anonName);
      setDataUrl(local);
      setServerFailed(true);
    } catch {
      try {
        setDataUrl(await drawLocal(picked, ratio, map, anonName));
        setServerFailed(true);
      } catch {
        toast.error('这张图没能生成出来，换一种比例再试一次。');
      }
    } finally {
      setBusy(false);
    }
  }, [picked, ratio, revealName, nickname, characterName, sessionId, map, anonName]);

  const shareLink = useMutation({
    mutationFn: async () => {
      const code = await createShare(sessionId, picked.map((m) => m.id));
      return `${window.location.origin}${import.meta.env.BASE_URL}s/${code}`;
    },
    onSuccess: (url) => {
      void navigator.clipboard?.writeText(url).catch(() => undefined);
      toast.ok('链接复制好了。别人点开能看到这几句话的开头。', 5000);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Sheet title="做成一张图" onClose={onClose} wide dirty={Boolean(dataUrl)}>
      <div className="col share-body">
        <p className="muted share-sub">勾了 {picked.length} 条。这些原话会出现在图上，先发给自己看一眼再决定要不要给别人。</p>

        {/* ★ 明示将被公开的具体内容 */}
        <ul className="share-contents">
          {picked.slice(0, 6).map((m) => (
            <li key={m.id}>
              <b>{anonName(m.role)}</b>：{clip(plainText(m.content), 46)}
            </li>
          ))}
          {picked.length > 6 ? <li className="muted">…另外 {picked.length - 6} 条也会一起出现</li> : null}
        </ul>

        <div className="row share-ratios" role="group" aria-label="图片比例">
          {RATIOS.map((r) => (
            <button
              key={r.key} type="button"
              className={`chip${ratio === r.key ? ' chip-on' : ''}`}
              aria-pressed={ratio === r.key}
              onClick={() => setRatio(r.key)}
            >
              {r.label}<span className="chip-note">{r.note}</span>
            </button>
          ))}
        </div>

        <label className="row share-anon">
          <input type="checkbox" checked={revealName} onChange={(e) => setRevealName(e.target.checked)} />
          <span className="col grow">
            <span className="row share-anon-top">
              <IconEye size={15} /> <b>图上带上我的昵称</b>
            </span>
            <span className="muted">
              默认不带。带上之后，图里"{`某人`}"的位置会变成你的名字。
            </span>
          </span>
          {revealName ? (
            <input
              className="share-nick" value={nickname} maxLength={24}
              placeholder="想显示的名字" aria-label="图上显示的名字"
              onChange={(e) => setNickname(e.target.value)}
            />
          ) : null}
        </label>

        {revealName && !nickname.trim() ? (
          <p className="share-warn"><IconWarning size={15} /> <span>勾了带名字但还没填，先写一个。</span></p>
        ) : null}

        <button type="button" className="btn btn-primary" onClick={() => void generate()} disabled={busy || !picked.length}>
          {busy ? '出图中…' : dataUrl ? '换一种排法重出' : '生成这张图'}
        </button>

        {serverFailed && dataUrl ? (
          <p className="muted share-localnote">
            这张是在你这台设备上画的（服务器出图那边暂时不通）。内容一样，字体会跟着你的设备走。
          </p>
        ) : null}

        {dataUrl ? (
          <figure className="share-preview">
            <img src={dataUrl} alt="分享图预览" loading="lazy" />
            <figcaption className="row share-fig-foot">
              <a
                className="btn" href={dataUrl} download={`echosoul-${sessionId.slice(0, 8)}.png`}
              >
                <IconDownload size={16} /> <span>存到手机</span>
              </a>
              <button type="button" className="btn" onClick={() => shareLink.mutate()} disabled={shareLink.isPending}>
                <IconShare size={16} /> <span>{shareLink.isPending ? '生成中…' : '只要个链接'}</span>
              </button>
            </figcaption>
          </figure>
        ) : null}

      </div>
    </Sheet>
  );
}

// ── 本地绘制 ───────────────────────────────────────────
const PAD = 64;
const LINE_H = 46;
const GAP_BLOCK = 34;
const MAX_LINES = 6;

async function drawLocal(
  rows: MessageRow[],
  ratio: Ratio,
  _map: ReturnType<typeof buildStickerMap>,
  nameOf: (role: MessageRow['role']) => string,
): Promise<string> {
  const cfg = RATIOS.find((r) => r.key === ratio)!;
  const width = cfg.w;

  // 先用一个临时 canvas 量高，长图模式的高度完全由内容决定
  const probe = document.createElement('canvas');
  probe.width = width;
  const pctx = probe.getContext('2d');
  if (!pctx) throw new Error('CANVAS_UNAVAILABLE');
  const blocks = layout(pctx, rows, width, nameOf);
  const contentH = blocks.reduce((sum, b) => sum + b.h + GAP_BLOCK, 0);
  const footerH = 132;
  const headerH = 96;
  const height = ratio === 'long'
    ? Math.max(headerH + contentH + footerH, 600)
    : (cfg.h ?? 1440);

  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('CANVAS_UNAVAILABLE');

  // 颜色从 CSS 变量读，跟随当前皮肤；兜底值取自 token 生成物（同一个源），
  // 而不是在这里手抄一份色号 —— 抄了就等于又造了一个不会跟着换肤的副本。
  const css = getComputedStyle(document.documentElement);
  const tk = TOKENS.tier1 as Record<string, string>;
  const t3 = TOKENS.tier3 as Record<string, string>;
  // fallback 放宽为 string | undefined：TOKENS 在 noUncheckedIndexedAccess 下
  // 索引结果本就可能是 undefined，逼调用点逐个写 ?? '' 只会产出 11 处噪音。
  const v = (name: string, fallback: string | undefined) =>
    css.getPropertyValue(name).trim() || fallback || '';
  const fontBody = v('--f-body', tk['font.body']);
  const fontRole = v('--f-display', tk['font.display']);
  const paper = v('--c-paper', tk['color.paper']);
  const ink = v('--c-ink', tk['color.ink']);
  const faint = v('--c-ink-faint', tk['color.ink-faint']);
  const roleBg = v('--bubble-role-bg', t3['bubble-role-bg']);
  const userBg = v('--bubble-user-bg', t3['bubble-user-bg']);
  const hairline = v('--c-hairline', tk['color.hairline']);

  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = faint;
  ctx.font = `400 28px ${fontBody}`;
  ctx.textBaseline = 'top';
  ctx.fillText(new Date().toLocaleDateString('zh-CN'), PAD, 44);

  let y = headerH;
  for (const b of blocks) {
    ctx.fillStyle = b.role === 'user' ? userBg : roleBg;
    roundRect(ctx, PAD, y, width - PAD * 2, b.h, 20);
    ctx.fill();

    ctx.fillStyle = faint;
    ctx.font = `400 24px ${fontBody}`;
    ctx.fillText(b.name, PAD + 22, y + 16);

    ctx.fillStyle = b.role === 'user' ? v('--bubble-user-fg', t3['bubble-user-fg']) : v('--bubble-role-fg', t3['bubble-role-fg']);
    ctx.font = `${b.role === 'user' ? 400 : 500} 30px ${b.role === 'user' ? fontBody : fontRole}`;
    b.lines.forEach((line, i) => ctx.fillText(line, PAD + 22, y + 56 + i * LINE_H));

    y += b.h + GAP_BLOCK;
  }

  // 超过一页（非长图）时给出提示而不是把内容裁掉看不见
  if (ratio !== 'long' && y + footerH > height) {
    ctx.fillStyle = faint;
    ctx.font = `400 26px ${fontBody}`;
    ctx.fillText('这一段还有后续 —— 想要完整的，长按右边的链接看。', PAD, height - footerH - 8);
  }

  // ★ 强制标识：画进像素，转存与二次截图都拿不掉（29 号专篇）
  ctx.strokeStyle = hairline;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, height - footerH + 20);
  ctx.lineTo(width - PAD, height - footerH + 20);
  ctx.stroke();

  ctx.fillStyle = faint;
  ctx.font = `400 24px ${fontBody}`;
  ctx.fillText('内容由 AI 生成 · 角色为虚构', PAD, height - footerH + 44);
  ctx.fillStyle = ink;
  ctx.font = `600 26px ${fontBody}`;
  ctx.fillText('星回 EchoSoul', PAD, height - 62);

  return c.toDataURL('image/png');
}

interface Block { role: MessageRow['role']; name: string; lines: string[]; h: number }

function layout(
  ctx: CanvasRenderingContext2D,
  rows: MessageRow[],
  width: number,
  nameOf: (role: MessageRow['role']) => string,
): Block[] {
  return rows.map((m) => {
    // 表情标记在图上一律降级成 caption 文本：外部图片绘进 canvas 有跨域污染风险
    const text = plainText(m.content);
    const lines = wrap(ctx, text, width - PAD * 2 - 44, 30);
    const shown = lines.slice(0, MAX_LINES);
    if (lines.length > MAX_LINES) shown[MAX_LINES - 1] = `${shown[MAX_LINES - 1] ?? ''}…`;
    return { role: m.role, name: nameOf(m.role), lines: shown, h: 56 + shown.length * LINE_H + 18 };
  });
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number, size: number): string[] {
  ctx.font = `400 ${size}px sans-serif`;
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let cur = '';
    for (const ch of para) {
      if (ctx.measureText(cur + ch).width > maxW) { out.push(cur); cur = ch; }
      else cur += ch;
    }
    out.push(cur);
  }
  return out;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 去掉 [emoji:x] 标记与 markdown 噪声，得到图上真正显示的文字 */
function plainText(s: string): string {
  return splitWithStickers(s, { byToken: new Map(), byCaption: new Map() })
    .map((p) => (p.kind === 'text' ? p.value : `[${p.alt}]`))
    .join('')
    .replace(/[*_`>#]/g, '')
    .trim();
}

function clip(s: string, n: number): string { return s.length > n ? `${s.slice(0, n)}…` : s; }
