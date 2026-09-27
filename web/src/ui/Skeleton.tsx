/**
 * Skeleton.tsx — 骨架屏
 *
 * 存在的理由：分册 §10 要求 FCP ≤ 1.8s，而"数据还没到"的空白页在用户眼里
 * 等于卡死。骨架必须**贴近真实布局**，否则内容到位时整页跳动（CLS）。
 *
 * prefers-reduced-motion 下 shimmer 由 base.css 的全局规则压成静止，
 * 本组件不另写媒体查询 —— 重复一套就等于两套可能不一致。
 */
import type { CSSProperties } from 'react';

export interface SkeletonProps {
  /** 高度（布局像素） */
  h?: number;
  w?: number | string;
  round?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function Skeleton({ h = 16, w = '100%', round, className, style }: SkeletonProps) {
  return (
    <span
      className={`ui-skeleton${round ? ' ui-skeleton-round' : ''}${className ? ` ${className}` : ''}`}
      style={{ height: h, width: w, borderRadius: round ? '50%' : 'var(--r-sm)', ...style }}
      aria-hidden="true"
    />
  );
}

/** 列表骨架：行数对齐真实行高，避免加载完成后的位移 */
export function SkeletonRows({ count = 6, h = 56, gap = 8 }: { count?: number; h?: number; gap?: number }) {
  return (
    <div className="ui-skeleton-rows" style={{ gap }} role="status" aria-label="加载中">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} h={h} round={false} style={{ opacity: 1 - i * 0.09 }} />
      ))}
    </div>
  );
}
