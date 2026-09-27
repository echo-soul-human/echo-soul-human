/**
 * icons.tsx — 线性图标集（分册 §4：禁止 emoji 当图标）
 *
 * 为什么不引 lucide-react：它已经在 package.json 里，但首屏 JS 预算是 180KB gzip
 * （分册 §10），而对话页真正需要的图标只有十几个。自绘一套 stroke 统一的线性图标
 * 既能守住"没有 AI 味"的线条语言，也让图标粗细成为可改一处的设计决策。
 *
 * 全部 currentColor + fill=none：颜色由消费方通过 var(--c-*) / var(--text-*) 决定，
 * 本文件不出现任何色值 —— 这是皮肤能跟随的前提。
 */
import type { SVGProps } from 'react';
import { ICON_STROKE } from './tokens';

type IconProps = SVGProps<SVGSVGElement> & { size?: number; title?: string };

function Svg({ size = 20, title, children, ...rest }: IconProps) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth={ICON_STROKE}
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export const IconPin = (p: IconProps) => (
  <Svg {...p}><path d="M9 4h6l-1 6 3 3H7l3-3-1-6Z" /><path d="M12 13v7" /></Svg>
);
export const IconArchive = (p: IconProps) => (
  <Svg {...p}><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" /><path d="M10 13h4" /></Svg>
);
export const IconPencil = (p: IconProps) => (
  <Svg {...p}><path d="M4 20h4l10-10-4-4L4 16v4Z" /><path d="M14 6l4 4" /></Svg>
);
export const IconTrash = (p: IconProps) => (
  <Svg {...p}><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" /><path d="M10 11v6M14 11v6" /></Svg>
);
export const IconPlus = (p: IconProps) => (
  <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>
);
export const IconClose = (p: IconProps) => (
  <Svg {...p}><path d="M6 6l12 12M18 6 6 18" /></Svg>
);
export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}><path d="M9 5l7 7-7 7" /></Svg>
);
export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}><path d="M5 9l7 7 7-7" /></Svg>
);
export const IconBack = (p: IconProps) => (
  <Svg {...p}><path d="M15 5l-7 7 7 7" /></Svg>
);
export const IconCheck = (p: IconProps) => (
  <Svg {...p}><path d="M4 12l5 5L20 6" /></Svg>
);
export const IconSearch = (p: IconProps) => (
  <Svg {...p}><circle cx="11" cy="11" r="6" /><path d="M16 16l4 4" /></Svg>
);
export const IconSettings = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M4.2 7.5l2.6 1.5M17.2 15l2.6 1.5M4.2 16.5l2.6-1.5M17.2 9l2.6-1.5" /></Svg>
);
export const IconBell = (p: IconProps) => (
  <Svg {...p}><path d="M6 16V11a6 6 0 0 1 12 0v5" /><path d="M4 16h16" /><path d="M10 19a2 2 0 0 0 4 0" /></Svg>
);
export const IconLock = (p: IconProps) => (
  <Svg {...p}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></Svg>
);
export const IconEye = (p: IconProps) => (
  <Svg {...p}><path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12Z" /><circle cx="12" cy="12" r="2.5" /></Svg>
);
export const IconPlay = (p: IconProps) => (
  <Svg {...p}><path d="M8 5l10 7-10 7V5Z" /></Svg>
);
export const IconStop = (p: IconProps) => (
  <Svg {...p}><rect x="6" y="6" width="12" height="12" rx="1" /></Svg>
);
export const IconImage = (p: IconProps) => (
  <Svg {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M4 17l5-4 4 3 3-2 4 3" /></Svg>
);
export const IconShare = (p: IconProps) => (
  <Svg {...p}><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M8.3 10.8l7.4-3.6M8.3 13.2l7.4 3.6" /></Svg>
);
export const IconDownload = (p: IconProps) => (
  <Svg {...p}><path d="M12 4v11" /><path d="M7 11l5 5 5-5" /><path d="M5 20h14" /></Svg>
);
export const IconFlag = (p: IconProps) => (
  <Svg {...p}><path d="M6 21V4" /><path d="M6 5h11l-2 4 2 4H6" /></Svg>
);
export const IconCoins = (p: IconProps) => (
  <Svg {...p}><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" /><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" /></Svg>
);
export const IconKey = (p: IconProps) => (
  <Svg {...p}><circle cx="8" cy="12" r="4" /><path d="M12 12h9" /><path d="M17 12v3M20 12v4" /></Svg>
);
export const IconBook = (p: IconProps) => (
  <Svg {...p}><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Z" /><path d="M4 19a2 2 0 0 1 2-2h13" /></Svg>
);
export const IconUsers = (p: IconProps) => (
  <Svg {...p}><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0" /><path d="M16 6a3 3 0 0 1 0 5" /><path d="M18 20a6 6 0 0 0-2-4" /></Svg>
);
export const IconMessage = (p: IconProps) => (
  <Svg {...p}><path d="M4 5h16v10H9l-5 4V5Z" /></Svg>
);
export const IconMemory = (p: IconProps) => (
  <Svg {...p}><path d="M6 5h5v14H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" /><path d="M13 5h5a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5v-4" /><path d="M13 9h5M13 15h5" /></Svg>
);
export const IconWarning = (p: IconProps) => (
  <Svg {...p}><path d="M12 4 21 20H3L12 4Z" /><path d="M12 10v5" /><path d="M12 17.5v.5" /></Svg>
);
export const IconInfo = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 11v6" /><path d="M12 7.5v.5" /></Svg>
);
export const IconRefresh = (p: IconProps) => (
  <Svg {...p}><path d="M20 12a8 8 0 1 1-3-6.2" /><path d="M20 4v5h-5" /></Svg>
);
export const IconSmile = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M9 10.5v.5M15 10.5v.5" /><path d="M8.5 15a4.5 4.5 0 0 0 7 0" /></Svg>
);
export const IconPalette = (p: IconProps) => (
  <Svg {...p}><path d="M12 3a9 9 0 0 0 0 18h2a2 2 0 0 0 0-4h-1a2 2 0 0 1 0-4h3a5 5 0 0 0 5-5 6 6 0 0 0-9-5Z" /><circle cx="8" cy="10" r="1" /><circle cx="12" cy="7" r="1" /></Svg>
);
export const IconMic = (p: IconProps) => (
  <Svg {...p}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 12a7 7 0 0 0 14 0" /><path d="M12 19v2" /></Svg>
);
export const IconMore = (p: IconProps) => (
  <Svg {...p}><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></Svg>
);
export const IconSend = (p: IconProps) => (
  <Svg {...p}><path d="M12 20V5" /><path d="M6 11l6-6 6 6" /></Svg>
);
