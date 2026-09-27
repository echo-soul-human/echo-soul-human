/**
 * AuthGate.tsx — 进入门
 *
 * ★ 北极星是「新用户首次对话完成率」，而 BYOK 产品的第一流失点就是
 *   "先注册 / 先填 Key"（I2 定案）。所以这里的第一选项必须是"先聊聊"，
 *   注册和配 Key 都排在后面。
 *
 * 实现依赖 Supabase 项目开启 Anonymous sign-ins
 *   （Dashboard → Authentication → Providers → Anonymous）。
 *   未开启时本组件会降级到邮箱验证码，并在控制台提示需要开的开关。
 *
 * 匿名会话也是正式会话：auth.users 插入会触发 002 的 on_user_created，
 * 自动建 profiles / entitlements / balances（Free 档），
 * 所以匿名用户体验到的额度与权益是真实生效的，不是假数据。
 */
import { useCallback, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { platform } from '../../lib/platform';

type Mode = 'idle' | 'email';

export function AuthGate() {
  const [mode, setMode] = useState<Mode>('idle');
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const agreed = useAgreement();

  /** 先聊聊：匿名登录，不收集任何身份信息 */
  const chatNow = useCallback(async () => {
    if (!agreed.value) { agreed.ask('先聊聊'); return; }
    setBusy(true);
    setErr(null);
    const { error } = await supabase.auth.signInAnonymously();
    if (error) {
      // 最常见原因：项目没开 Anonymous sign-ins
      console.warn('[AuthGate] 匿名登录失败，需检查 Authentication → Providers → Anonymous：', error.message);
      setErr('这条路暂时没开，先用邮箱登录吧。');
      setMode('email');
    }
    setBusy(false);
  }, [agreed]);

  const sendOtp = async () => {
    if (!agreed.value) { agreed.ask('注册'); return; }
    const e = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) { setErr('邮箱格式不太对'); return; }
    setBusy(true);
    setErr(null);
    const { error } = await supabase.auth.signInWithOtp({
      email: e,
      options: { shouldCreateUser: true },
    });
    setBusy(false);
    if (error) setErr(otpMessage(error.message));
    else setSent(true);
  };

  return (
    <div className="gate">
      <div className="gate-brand">
        <span className="gate-name">星回</span>
        <span className="gate-slogan">有人回应的，才叫爱</span>
      </div>

      {mode !== 'email' ? (
        <>
          <button type="button" className="btn btn-primary gate-primary" onClick={chatNow} disabled={busy}>
            先聊聊
          </button>
          <p className="gate-hint muted">不用注册，不用填任何 Key。聊上几句再决定要不要留下。</p>
          <button type="button" className="btn gate-alt" onClick={() => setMode('email')}>
            用邮箱登录
          </button>
        </>
      ) : (
        <div className="gate-email">
          {sent ? (
            <p className="gate-sent">验证码已发出，去 <b>{email}</b> 收一下，回来这个页面会自动登录。</p>
          ) : (
            <>
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="你的邮箱"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void sendOtp(); }}
              />
              <button type="button" className="btn btn-primary" onClick={sendOtp} disabled={busy}>
                收验证码
              </button>
            </>
          )}
          <button type="button" className="btn gate-alt" onClick={() => setMode('idle')}>返回</button>
        </div>
      )}

      {err ? <p className="gate-err" role="alert">{err}</p> : null}

      <AgreementCheck agreed={agreed.value} onChange={agreed.set} />

      <p className="gate-ai-note">
        这里的所有回复都由人工智能生成，角色是虚构的。
        {!platform.isStandalone() && platform.isIOS() ? ' 用 Safari 的「添加到主屏幕」打开，体验和通知都会更稳。' : ''}
      </p>
    </div>
  );
}

function otpMessage(raw: string): string {
  if (/rate|timeout/i.test(raw)) return '发得太快了，等一分钟再试。';
  if (/security/i.test(raw)) return '这一步被安全策略拦住了，换个邮箱试试。';
  return '发送失败，稍后再试。';
}

// ── 协议勾选门：每次都勾，不记住上次同意（01 号专篇 §2.4）──
function useAgreement() {
  const [value, setValue] = useState(false);
  const [pendingAction, setPending] = useState<string | null>(null);

  const ask = useCallback((action: string) => {
    setPending(action);
    if (typeof document !== 'undefined') {
      // 把焦点带到勾选框，比弹一层对话框省事也更少被忽略
      requestAnimationFrame(() =>
        document.querySelector<HTMLInputElement>('[data-agreement]')?.focus());
    }
  }, []);

  return { value, set: setValue, ask, pendingAction };
}

function AgreementCheck({ agreed, onChange }: { agreed: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="gate-agree">
      <input type="checkbox" data-agreement checked={agreed} onChange={(e) => onChange(e.target.checked)} />
      <span>
        我已阅读并同意
        <a href="#/legal/terms">《用户服务协议》</a>与
        <a href="#/legal/privacy">《隐私政策》</a>
      </span>
    </label>
  );
}
