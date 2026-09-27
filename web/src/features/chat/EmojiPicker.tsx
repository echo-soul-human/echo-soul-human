/**
 * EmojiPicker.tsx — 表情选择器（发的是"你自己的贴纸"，不是系统 emoji）
 *
 * 为什么不放一堆 Unicode emoji：分册 §4 明确把"emoji 当图标"列为 AI 味重灾区，
 * 而这里的定位是**用户自己上传的表情包**（2.2 节）。选一张 → 输入框插入
 * `[emoji:token]` → 发送出去后由 StickerText 渲染成图。
 *
 * 三条实现约束：
 *   · 目录来自 sticker_catalog RPC，只给 token + caption，不给图（省 token 的机制
 *     在服务端；前端要显示缩略图得再查 stickers 表 —— 这里就是这么做）。
 *   · 空态不能只是"没有表情"：必须给出"去设置里传一批"的路径，否则这个按钮像坏了。
 *   · 键盘可达：方向键在网格里移动，Enter 选中，Esc 关闭。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { keys, stickerCatalog, toMessage } from '../rpc';
import { IconClose, IconSmile } from '../../ui/icons';
import { Empty } from '../../ui/Empty';
import { Skeleton } from '../../ui/Skeleton';

interface StickerFull { token: string; caption: string; path: string }

export interface EmojiPickerProps {
  sessionId: string;
  open: boolean;
  /** 选中后往输入框插入 [emoji:token] */
  onPick: (token: string) => void;
  onClose: () => void;
}

const COLS = 5;

export function EmojiPicker({ sessionId, open, onPick, onClose }: EmojiPickerProps) {
  const [cursor, setCursor] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);

  const q = useQuery({
    queryKey: keys.stickerCatalog(sessionId),
    queryFn: async (): Promise<StickerFull[]> => {
      // catalog 只回 token/caption（服务端为省 token 刻意不给路径），
      // 缩略图另按自己的行取 —— RLS 保证只能拿到自己的。
      const cat = await stickerCatalog(sessionId);
      if (!cat.length) return [];
      const tokens = cat.map((c) => c.token);
      const { data, error } = await supabase.from('stickers')
        .select('token,caption,path').in('token', tokens);
      if (error) throw new Error(toMessage(error.code, error.message));
      const order = new Map(cat.map((c, i) => [c.token, i]));
      return ((data ?? []) as StickerFull[])
        .sort((a, b) => (order.get(a.token) ?? 0) - (order.get(b.token) ?? 0));
    },
    enabled: open,
    staleTime: 120_000,
  });

  const items = useMemo(() => q.data ?? [], [q.data]);

  const pick = useCallback((s: StickerFull) => { onPick(s.token); onClose(); }, [onPick, onClose]);

  // 方向键导航：网格里的线性焦点对读屏用户比 Tab 逐个更可用
  useEffect(() => {
    if (!open) return;
    const el = gridRef.current;
    el?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (!items.length) return;
      const move = (n: number) => {
        e.preventDefault();
        setCursor((c) => Math.min(items.length - 1, Math.max(0, c + n)));
      };
      switch (e.key) {
        case 'ArrowRight': move(1); break;
        case 'ArrowLeft': move(-1); break;
        case 'ArrowDown': move(COLS); break;
        case 'ArrowUp': move(-COLS); break;
        case 'Home': e.preventDefault(); setCursor(0); break;
        case 'End': e.preventDefault(); setCursor(items.length - 1); break;
        case 'Enter':
        case ' ': {
          e.preventDefault();
          const s = items[cursor];
          if (s) pick(s);
          break;
        }
        default: break;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, items, cursor, pick]);

  if (!open) return null;

  return (
    <div className="emoji-pop" role="dialog" aria-modal="false" aria-label="表情">
      <header className="emoji-head">
        <span className="grow">表情</span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭表情">
          <IconClose size={17} />
        </button>
      </header>

      {q.isLoading ? (
        <div className="emoji-grid">
          {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} h={56} round={false} />)}
        </div>
      ) : null}

      {!q.isLoading && items.length === 0 ? (
        <div className="emoji-empty">
          <Empty
            title="还没有表情"
            hint={<>表情包要你自己传：设置里的「表情与立绘」可以一次拖几十张，传完就能在这里选。<br />角色也会从这些表情里挑着发给你。</>}
            icon={<IconSmile />}
          />
        </div>
      ) : null}

      {items.length > 0 ? (
        <>
          <div
            ref={gridRef} className="emoji-grid scroll-pane-x" tabIndex={-1}
            role="listbox" aria-label="已启用的表情" aria-activedescendant={`emoji-${cursor}`}
          >
            {items.map((s, i) => (
              <button
                key={s.token}
                id={`emoji-${i}`}
                type="button" role="option" aria-selected={i === cursor}
                className={`emoji-cell${i === cursor ? ' emoji-cur' : ''}`}
                onClick={() => pick(s)}
                onMouseEnter={() => setCursor(i)}
                title={s.caption || undefined}
              >
                {/* 图片本身是内容，alt 用 caption；没 caption 时退化为"表情 N" */}
                <img src={s.path} alt={s.caption || `表情 ${i + 1}`} width={48} height={48} loading="lazy" decoding="async" />
                {s.caption ? <span className="emoji-cap">{s.caption}</span> : null}
              </button>
            ))}
          </div>
          <p className="muted emoji-hint">点一下就插进输入框，可以再打字一起发。</p>
        </>
      ) : null}
    </div>
  );
}

/** 输入框里的表情占位（小尺寸预览，非完整渲染） */
export function InlineStickerToken({ token, path }: { token: string; path?: string }) {
  return path
    ? <img className="emoji-inline" src={path} alt="" width={20} height={20} />
    : <code className="emoji-code">{`[emoji:${token}]`}</code>;
}
