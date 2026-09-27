/**
 * Sheet.tsx — 底部抽屉（分册 §13 无障碍：可键盘到达、焦点环不隐藏）
 *
 * 三条必须做对的规矩，否则键盘用户会被困在抽屉里：
 *   1. ESC 与遮罩点击都能关；但**表单有未保存内容时不能一键关掉** ——
 *      用户写了一半的人设被一次误触抹掉，比没有抽屉更糟。
 *   2. 焦点陷阱：Tab 到最后一个元素后回到第一个，Shift+Tab 反向同理。
 *   3. 关闭后焦点还给打开它的那个按钮（body 里挂 data-opener）。
 *
 * iOS 相关：容器用 max-height: 88dvh + overflow-y:auto，
 * 外层滚动交给 .scroll-pane，抽屉自己就是最内层滚动容器，不再嵌第二层。
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { IconClose } from './icons';
import { FOCUS_POLL_MS } from './tokens';

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'textarea:not([disabled])', 'select:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface SheetProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 底部固定操作区（确认/取消），放在滚动区之外 */
  footer?: ReactNode;
  /** 有未保存改动时置 true：遮罩与 ESC 不再直接关，先问一句 */
  dirty?: boolean;
  /** 宽版抽屉：角色详情这类信息量大的面板用 */
  wide?: boolean;
}

export function Sheet({ title, onClose, children, footer, dirty, wide }: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [blocked, setBlocked] = useState(false);
  const titleId = useId();

  // body 滚动锁：抽屉打开时背景不该跟着滚（iOS 上背景滚动会把抽屉顶偏）
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  const attemptClose = useCallback(() => {
    if (dirty) {
      setBlocked(true);
      requestAnimationFrame(() =>
        panelRef.current?.querySelector<HTMLButtonElement>('[data-discard]')?.focus());
      return;
    }
    onClose();
  }, [dirty, onClose]);

  // ESC 关闭 + 焦点陷阱
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); attemptClose(); return; }
      if (e.key !== 'Tab') return;
      const root = panelRef.current;
      if (!root) return;
      const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [attemptClose]);

  // 挂载后把焦点带进抽屉；卸载后还给打开它的那个元素
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => {
      const root = panelRef.current;
      const target = root?.querySelector<HTMLElement>('[data-autofocus]')
        ?? root?.querySelector<HTMLElement>(FOCUSABLE);
      target?.focus();
    });
    return () => {
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  // 焦点被浏览器"漏"出抽屉时拉回来（原生 select / 日期控件会这样）。
  // 只在焦点确实掉到 body/document 外面时才动，否则会把用户正在操作的控件抢走。
  useEffect(() => {
    const t = setInterval(() => {
      const root = panelRef.current;
      if (!root) return;
      const active = document.activeElement;
      if (active && root.contains(active)) return;
      if (!active || active === document.body || !document.contains(active)) {
        root.querySelector<HTMLElement>(FOCUSABLE)?.focus();
      }
    }, FOCUS_POLL_MS);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="ui-sheet" onClick={(e) => { if (e.target === e.currentTarget) attemptClose(); }}>
      <div
        ref={panelRef}
        className={`ui-sheet-panel${wide ? ' ui-sheet-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="ui-sheet-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="ui-sheet-x" onClick={attemptClose} aria-label="关闭">
            <IconClose />
          </button>
        </header>

        <div className="ui-sheet-body scroll-pane">{children}</div>

        {footer ? <footer className="ui-sheet-foot">{footer}</footer> : null}

        {blocked ? (
          <div className="ui-sheet-guard" role="alertdialog" aria-label="确认放弃改动">
            <p>还没保存，确定要放弃这些改动吗？</p>
            <div className="row">
              <button type="button" className="btn" onClick={() => setBlocked(false)}>继续编辑</button>
              <button
                type="button" data-discard className="btn btn-danger"
                onClick={() => { setBlocked(false); onClose(); }}
              >
                放弃改动
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
