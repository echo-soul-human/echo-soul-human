/**
 * platform.ts — 端能力探测
 *
 * 存在的意义：本项目要在 iOS Safari、iOS 主屏 WebApp、安卓浏览器、
 * PC 浏览器四种表面上表现一致，差异必须集中在一处判断，
 * 否则能力检测会散落到每个组件里。
 */

function ua(): string {
  return typeof navigator === 'undefined' ? '' : navigator.userAgent;
}

export const platform = {
  isIOS(): boolean {
    // iPadOS 13+ 的 UA 伪装成 Mac，靠触点数区分
    return /iPad|iPhone|iPod/.test(ua())
      || (/Macintosh/.test(ua()) && typeof document !== 'undefined'
          && 'ontouchend' in document
          && (navigator as unknown as { maxTouchPoints?: number }).maxTouchPoints === 5);
  },

  isAndroid(): boolean {
    return /Android/.test(ua());
  },

  /** 是否以 standalone 运行（已加主屏 / 已安装 PWA） */
  isStandalone(): boolean {
    if (typeof window === 'undefined') return false;
    const mm = window.matchMedia?.('(display-mode: standalone)').matches;
    // iOS Safari 早期版本不认 display-mode
    const ios = (navigator as unknown as { standalone?: boolean }).standalone === true;
    return Boolean(mm || ios);
  },

  /**
   * Web Push 是否可能可用。
   * iOS 必须是 standalone + iOS 16.4+，否则 pushManager.subscribe 会直接抛错。
   */
  canPush(): boolean {
    if (typeof window === 'undefined') return false;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
    if (Notification?.permission === 'denied') return false;
    if (this.isIOS()) {
      return this.isStandalone() && iosVersion() >= 16.4;
    }
    return true;
  },

  /** 是否支持 dvh（不支持时 CSS 走 @supports 回落） */
  supportsDvh(): boolean {
    return typeof CSS !== 'undefined' && CSS.supports?.('height', '100dvh') === true;
  },

  /** 键盘占用的视口高度差（iOS 键盘顶起页面时用来抬输入区） */
  keyboardInset(): number {
    if (typeof window === 'undefined' || !window.visualViewport) return 0;
    const vv = window.visualViewport;
    return Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  },

  /** 粗略判定低端设备，用于关闭纹理与动效 */
  isLowPowered(): boolean {
    const c = navigator as unknown as { deviceMemory?: number; hardwareConcurrency?: number };
    return (c.deviceMemory ?? 8) <= 4 || (c.hardwareConcurrency ?? 8) <= 4;
  },
};

function iosVersion(): number {
  const m = ua().match(/OS (\d+)[._](\d+)/);
  if (!m) return 0;
  return Number(`${m[1]}.${m[2]}`);
}

/** 订阅键盘高度变化，返回取消函数 */
export function onKeyboardInset(cb: (inset: number) => void): () => void {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) { cb(0); return () => {}; }
  const handler = () => cb(platform.keyboardInset());
  vv.addEventListener('resize', handler);
  vv.addEventListener('scroll', handler);
  handler();
  return () => {
    vv.removeEventListener('resize', handler);
    vv.removeEventListener('scroll', handler);
  };
}
