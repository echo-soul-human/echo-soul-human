/**
 * Toast.tsx — 轻提示
 *
 * 为什么不用 alert/confirm：那三个会阻塞主线程且无法样式化，在 iOS WebApp 里
 * 弹出来是系统外观，直接破坏"这是某个人的聊天界面"的沉浸感（分册 §4）。
 *
 * 三条规矩：
 *   · 用 aria-live="polite"，但**危险类用 assertive** —— 扣费失败必须打断读屏。
 *   · duration=0 表示不自动消失（错误默认走这条：用户得看清自己为什么没到账）。
 *   · 同一时刻最多 3 条，超了挤掉最旧的；刷屏等于没提示。
 *
 * 状态放在模块级 store 而不是 Context：Context 会把 Provider 塞进 App 外壳，
 * 而 router.tsx / App.tsx 不在本次改动范围内。订阅用 useSyncExternalStore，
 * 它是 React 官方给"外部可变源"用的唯一正确姿势。
 */
import { useSyncExternalStore, useCallback } from 'react';
import type { ReactNode } from 'react';
import { IconCheck, IconClose, IconWarning, IconInfo } from './icons';
import { TOAST_AUTO_DISMISS_MS } from './tokens';

export type ToastKind = 'ok' | 'info' | 'warn' | 'error';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
  /** 0 = 不自动消失 */
  duration: number;
}

const MAX_VISIBLE = 3;

let seq = 0;
let items: ToastItem[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function snapshot(): ToastItem[] {
  return items;
}

const timers = new Map<number, number>();

function remove(id: number): void {
  const t = timers.get(id);
  if (t !== undefined) { clearTimeout(t); timers.delete(id); }
  items = items.filter((x) => x.id !== id);
  emit();
}

function push(kind: ToastKind, text: string, duration?: number): number {
  const id = ++seq;
  const item: ToastItem = { id, kind, text, duration: duration ?? (kind === 'error' ? 0 : TOAST_AUTO_DISMISS_MS) };
  items = [...items, item].slice(-MAX_VISIBLE);
  emit();
  if (item.duration > 0) {
    timers.set(id, window.setTimeout(() => remove(id), item.duration));
  }
  return id;
}

/**
 * 全局调用点（非组件）也能用：mutation 的 onSuccess 回调里往往拿不到 hook。
 * 注意返回值可用于手动 dismiss。
 */
export const toast = {
  ok: (text: string, duration?: number) => push('ok', text, duration),
  info: (text: string, duration?: number) => push('info', text, duration),
  warn: (text: string, duration?: number) => push('warn', text, duration),
  error: (text: string, duration?: number) => push('error', text, duration),
  dismiss: remove,
};

export function useToast() {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot);
  const dismiss = useCallback((id: number) => remove(id), []);
  return { list, dismiss, toast };
}

const ICONS: Record<ToastKind, ReactNode> = {
  ok: <IconCheck />, info: <IconInfo />, warn: <IconWarning />, error: <IconWarning />,
};

export function ToastLayer() {
  const { list, dismiss } = useToast();
  if (!list.length) return null;
  return (
    <div className="ui-toasts">
      {list.map((t) => (
        <div key={t.id} className={`ui-toast ui-toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <span className="ui-toast-icon">{ICONS[t.kind]}</span>
          <span className="grow">{t.text}</span>
          <button type="button" className="ui-toast-x" onClick={() => dismiss(t.id)} aria-label="关掉这条提示">
            <IconClose size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
