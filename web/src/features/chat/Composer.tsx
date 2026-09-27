/**
 * Composer.tsx — 输入区
 *
 * iOS 相关（docs/分册-网页端.md §5.3）全在这一个组件里，别散出去：
 *   · font-size ≥ 16px，否则聚焦时页面自动放大且不缩回
 *   · 用 visualViewport 抬升，不靠 :focus 改布局
 *   · 中文输入法候选期间不得发送（compositionstart/end 加锁）
 *   · 收起键盘后回到底部，否则消息区留一大块空白
 *
 * 明确不做：任何"AI 帮你写"的输入增强。这个产品的核心是"我在和 TA 说话"，
 * 输入框里出现辅助生成会立刻破坏关系感。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { onKeyboardInset } from '../../lib/platform';

interface Props {
  sessionId: string;
  disabled?: boolean;
  streaming: boolean;
  onSend: (text: string) => void;
  onStop?: () => void;
  onComposingChange?: (v: boolean) => void;
}

const MAX_ROWS = 6;
const LINE_PX = 24;

export function Composer({ sessionId, disabled, streaming, onSend, onStop, onComposingChange }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [inset, setInset] = useState(0);
  const composingRef = useRef(false);

  // 草稿按会话分别存，切会话不串（刷新也不丢）
  const draftKey = `echosoul.draft.${sessionId}`;
  useEffect(() => {
    setText(localStorage.getItem(draftKey) ?? '');
    requestAnimationFrame(() => ref.current?.focus());
  }, [draftKey]);

  useEffect(() => {
    if (text) localStorage.setItem(draftKey, text);
    else localStorage.removeItem(draftKey);
  }, [text, draftKey]);

  // 键盘抬升：iOS 会把整个 visual viewport 顶上去
  useEffect(() => onKeyboardInset(setInset), []);

  // 自动增高，超过上限内部滚动
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, LINE_PX * MAX_ROWS + 16)}px`;
    el.style.overflowY = el.scrollHeight > LINE_PX * MAX_ROWS + 16 ? 'auto' : 'hidden';
  }, [text]);

  const send = useCallback(() => {
    if (composingRef.current) return;          // 候选词没上屏，不发
    const t = text.trim();
    if (!t || disabled || streaming) return;
    setText('');
    localStorage.removeItem(draftKey);
    onSend(t);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) el.style.height = 'auto';
    });
  }, [text, disabled, streaming, onSend, draftKey]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      // 移动端 Enter 即发送（enterkeyhint=send），换行走下面的按钮
      if (e.nativeEvent.isComposing || composingRef.current) return;
      e.preventDefault();
      send();
    }
  };

  const canSend = text.trim().length > 0 && !disabled && !streaming;

  return (
    <div className="composer" style={inset ? { transform: `translateY(${-inset}px)` } : undefined}>
      <div className="composer-row">
        <textarea
          ref={ref}
          className="composer-input"
          rows={1}
          value={text}
          placeholder={disabled ? '先续一下额度' : '说点什么…'}
          disabled={disabled}
          enterKeyHint="send"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label="消息输入框"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onCompositionStart={() => { composingRef.current = true; onComposingChange?.(true); }}
          onCompositionEnd={() => { composingRef.current = false; onComposingChange?.(false); }}
        />

        {streaming ? (
          <button type="button" className="btn composer-btn" onClick={onStop} aria-label="停止显示">
            ■
          </button>
        ) : (
          <button
            type="button" className="btn btn-primary composer-btn"
            onClick={send} disabled={!canSend} aria-label="发送"
          >
            ↑
          </button>
        )}
      </div>
    </div>
  );
}
