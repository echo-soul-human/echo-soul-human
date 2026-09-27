/**
 * Empty.tsx — 空态
 *
 * 分册里反复出现同一条要求：空态不能是空白页（StartView 的注释也写了）。
 * 空白页在用户眼里是"坏了"，而不是"还没有内容"。
 *
 * 本组件强制两件事：
 *   · 必须给 hint（解释为什么是空的）
 *   · 尽量给 action（下一步做什么）—— 没有动作的空态就是死路
 * 左对齐（§4：禁止正文居中对齐）。
 */
import type { ReactNode } from 'react';

export interface EmptyProps {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  /** 次要动作，比如"看看怎么做" */
  alt?: ReactNode;
  icon?: ReactNode;
}

export function Empty({ title, hint, action, alt, icon }: EmptyProps) {
  return (
    <div className="ui-empty">
      {icon ? <span className="ui-empty-icon" aria-hidden="true">{icon}</span> : null}
      <h3 className="ui-empty-title">{title}</h3>
      {hint ? <p className="ui-empty-hint muted">{hint}</p> : null}
      {action || alt ? (
        <div className="row ui-empty-actions">
          {action}
          {alt}
        </div>
      ) : null}
    </div>
  );
}
