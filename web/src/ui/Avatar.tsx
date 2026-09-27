/**
 * Avatar.tsx — 头像（含首字兜底）
 *
 * 两条来自分册的硬要求：
 *   · §10 图片必须显式宽高 + loading="lazy"，否则立绘加载完成会顶开布局（CLS）。
 *   · §5.6 iOS 7 天清站点存储 ⇒ 头像路径只能来自服务端，本地不缓存副本。
 *
 * 名字首字兜底不是装饰：官方角色与用户自建角色的 avatar_path 大量为空，
 * 空头像会让列表看起来像坏了。首字用 --f-display（衬线），
 * 与"TA 侧用衬线"的语言一致。
 */
import type { CSSProperties } from 'react';

export interface AvatarProps {
  /** 允许显式 undefined：调用方常把可能为空的头像路径直接透传 */
  src?: string | null | undefined;
  name: string;
  /** 直径，单位 px —— 这是布局尺寸不是字号，允许写字面量 */
  size?: number;
  /** 群聊多角色时传数组，叠放。允许显式 undefined 以便调用方直接透传 */
  group?: { src?: string | null; name: string }[] | undefined;
  className?: string;
  style?: CSSProperties;
}

export function Avatar({ src, name, size = 40, group, className, style }: AvatarProps) {
  if (group && group.length > 1) {
    return (
      <span
        className={`ui-avatar-stack${className ? ` ${className}` : ''}`}
        // CSS 自定义属性不在 CSSProperties 的已知键里，必须断言
        style={{ '--stack-size': `${size}px`, ...style } as CSSProperties}
        aria-hidden="true"
      >
        {group.slice(0, 3).map((g, i) => (
          <Avatar key={`${g.name}-${i}`} src={g.src} name={g.name} size={Math.round(size * 0.72)} />
        ))}
      </span>
    );
  }

  const initial = (group?.[0]?.name ?? name).slice(0, 1) || '?';
  return (
    <span
      className={`ui-avatar${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size, ...style }}
    >
      {src
        ? <img src={src} alt="" width={size} height={size} loading="lazy" decoding="async" />
        : <span className="ui-avatar-initial" aria-hidden="true">{initial}</span>}
      {/* 名字由外层文本给出，这里不重复播报 */}
    </span>
  );
}
