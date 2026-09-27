/**
 * Confirm.tsx — 危险操作二次确认（必须打字确认）
 *
 * 为什么不是 confirm("确定删除吗？")：删会话、注销账号是**不可逆**的，
 * 而"点两下同一个位置的按钮"这种确认对肌肉记忆完全无效 —— 用户是在第 N 次
 * 习惯性点击里删掉的东西。要求输入指定字符串，是唯一被证明有效的摩擦（09 号专篇）。
 *
 * 实现要点：
 *   · 待输入串由调用方给，且刻意与按钮文字不同（按钮写"删除"，要输 "删除会话"）
 *   · 输入不匹配时确认键禁用而不是报错 —— 报错会让用户以为自己操作错了
 *   · 中文输入法候选期间不得判定（composition），否则拼音没上屏就被判为不匹配
 *   · 键盘焦点默认落在取消而不是确认
 */
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Sheet } from './Sheet';
import { IconWarning } from './icons';

export interface ConfirmProps {
  title: string;
  /** 说明后果，必须具体到"会丢什么" */
  body: ReactNode;
  /** 需要精确输入的字符串；不传则退化为普通二次确认 */
  phrase?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function Confirm({
  title, body, phrase, confirmLabel = '确定', cancelLabel = '取消',
  danger = true, busy, onConfirm, onCancel,
}: ConfirmProps) {
  const [typed, setTyped] = useState('');
  const composingRef = useRef(false);
  const matched = !phrase || typed.trim() === phrase;

  return (
    <Sheet title={title} onClose={onCancel}>
      <div className="ui-confirm">
        {danger ? (
          <p className="ui-confirm-warn"><IconWarning size={18} /> <span>这一步不能撤销</span></p>
        ) : null}

        <div className="ui-confirm-body">{body}</div>

        {phrase ? (
          <div className="field">
            <label htmlFor="confirm-phrase">
              请输入 <b className="ui-confirm-phrase">{phrase}</b> 以确认
            </label>
            <input
              id="confirm-phrase"
              value={typed}
              autoComplete="off"
              spellCheck={false}
              aria-label={`输入 ${phrase} 以确认`}
              onChange={(e) => setTyped(e.target.value)}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={(e) => { composingRef.current = false; setTyped(e.currentTarget.value); }}
            />
          </div>
        ) : null}

        <div className="sheet-actions">
          <button type="button" className="btn" onClick={onCancel} data-autofocus>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            disabled={!matched || busy}
            onClick={onConfirm}
          >
            {busy ? '处理中…' : confirmLabel}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
