/**
 * CostPanel.tsx — 成本优化面板
 *
 * 这个面板的存在理由（分册-模型与计费 §8）：把成本从"藏起来的扣费"变成
 * "看得见的旋钮"。抖音上"我做了个能看见花了多少钱的聊天软件"本身就是传播素材。
 *
 * 三条必须写对的：
 *   1. **携带量是成本主体**，不是前缀（§3.1 表格里 E 占 94%）。所以滑杆拉到上限时
 *      必须明示消耗倍数和预计轮数 —— Ultra 512K 吃满会把毛利打负，用户也应该知道
 *      自己的额度会多快见底。
 *   2. 默认值是档位的 carry_default 而不是上限（B5/C3 定案：卖的是"能拉到"，不是"给你拉到"）。
 *   3. 这些参数**按会话**存（sessions.carry_tokens），召回条数与输出长度目前只有档位默认值，
 *      没有 per-session 列 —— 所以那两个改动只能作为待接入项标注清楚，不能假装已生效。
 *
 * ⚠ 服务端状态一律 TanStack Query；滑杆的未保存值属于瞬时状态放组件内。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { keys, patchSession, toMessage } from '../rpc';
import { SkeletonRows } from '../../ui/Skeleton';
import { toast } from '../../ui/Toast';
import { IconChevronDown, IconInfo, IconWarning } from '../../ui/icons';

/** 单轮估算：token → 元（DeepSeek 官方价量级，实测后由服务端覆盖） */
const YUAN_PER_M_TOKEN = 1.0;
/** 前缀 A+B 固定开销（§3.1 约 1400 token），不随携带量变 */
const PREFIX_TOKENS = 1400;
/** RAG 召回每条平均 token */
const RECALL_PER_ITEM = 300;

const OUTPUT_CHOICES = [
  { key: 'short', label: '简短', tokens: 400, hint: '一句到两句，像微信回消息' },
  { key: 'normal', label: '适中', tokens: 800, hint: '角色默认。三段以内' },
  { key: 'long', label: '详细', tokens: 1600, hint: '长信、独白式人设适合，但每轮更贵' },
] as const;

type OutputKey = (typeof OUTPUT_CHOICES)[number]['key'];

interface Entitlement {
  user_id: string;
  tier: string;
  carry_tokens: number;
  carry_default: number;
  recall_topk: number;
  window_limit: number;
}

export interface CostPanelProps {
  /** 有会话时才允许改携带量；无会话传 undefined，面板只读并解释原因 */
  sessionId?: string;
}

export function CostPanel({ sessionId }: CostPanelProps) {
  const qc = useQueryClient();

  const ent = useQuery({
    queryKey: keys.entitlements,
    queryFn: async (): Promise<Entitlement | null> => {
      const me = await supabase.auth.getUser();
      if (!me.data.user) return null;
      const { data, error } = await supabase.from('entitlements')
        .select('user_id,tier,carry_tokens,carry_default,recall_topk,window_limit')
        .eq('user_id', me.data.user.id).single();
      if (error) throw new Error(toMessage(error.code, error.message));
      return (data ?? null) as Entitlement | null;
    },
  });

  const session = useQuery({
    queryKey: ['session-carry', sessionId ?? ''],
    queryFn: async (): Promise<number | null> => {
      if (!sessionId) return null;
      const { data, error } = await supabase.from('sessions')
        .select('carry_tokens').eq('id', sessionId).maybeSingle();
      if (error) throw new Error(toMessage(error.code, error.message));
      return data?.carry_tokens ?? null;
    },
    enabled: Boolean(sessionId),
  });

  const e = ent.data;
  const maxCarry = e?.carry_tokens ?? 8192;
  const defaultCarry = e?.carry_default ?? maxCarry;

  // 未保存的滑杆值：瞬时状态，离开页面即弃
  const [carry, setCarry] = useState<number>(defaultCarry);
  const [recall, setRecall] = useState<number>(e?.recall_topk ?? 4);
  const [output, setOutput] = useState<OutputKey>('normal');
  const [eco, setEco] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const initialized = useRef(false);

  // 数据到位后才初始化一次，避免每次 refetch 把用户正在拖的滑杆弹回去
  useEffect(() => {
    if (!e || initialized.current) return;
    initialized.current = true;
    setCarry(session.data ?? e.carry_default);
    setRecall(e.recall_topk);
  }, [e, session.data]);

  const save = useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error('得先有一个会话');
      const ok = await patchSession({ id: sessionId, carry });
      if (!ok) throw new Error('这个会话改不了，可能已经不在了。');
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.sessions });
      if (sessionId) void qc.invalidateQueries({ queryKey: ['session-carry', sessionId] });
      toast.ok('这轮的携带量按新数值走');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const est = useMemo(() => estimate(carry, recall, output), [carry, recall, output]);
  const baseEst = useMemo(() => estimate(defaultCarry, e?.recall_topk ?? 4, 'normal'), [defaultCarry, e]);

  const multiplier = baseEst.yuan > 0 ? est.yuan / baseEst.yuan : 1;
  const atMax = carry >= maxCarry;

  return (
    <div className="cost-panel">
      <header className="panel-head">
        <h3>怎么花额度</h3>
        <p className="muted panel-sub">
          决定一轮贵不贵的，主要是 TA 每轮带着多少你们的过去。下面三个数你都能自己调。
        </p>
      </header>

      {ent.isLoading ? <SkeletonRows count={3} h={72} gap={10} /> : null}
      {ent.isError ? <p className="cd-notice cd-notice-bad">读不到档位设置。</p> : null}

      {e ? (
        <>
          {/* ── 携带量 ─────────────────────────────── */}
          <section className="cost-block">
            <div className="row cost-label-row">
              <label htmlFor="carry" className="cost-label">每轮携带的历史</label>
              <span className="cost-value">{fmtTokens(carry)}</span>
            </div>
            <input
              id="carry" type="range" min={1024} max={maxCarry} step={1024}
              value={carry} disabled={!sessionId}
              onChange={(ev) => { setCarry(Number(ev.target.value)); if (Number(ev.target.value) > defaultCarry) setEco(false); }}
              aria-describedby="carry-desc"
            />
            <div className="row cost-scale">
              <span className="muted">省 · {fmtTokens(1024)}</span>
              <span className="muted">档位默认 · {fmtTokens(defaultCarry)}</span>
              <span className="muted">上限 · {fmtTokens(maxCarry)}</span>
            </div>
            <p id="carry-desc" className="muted cost-hint">
              这个数字越大，TA 越不容易忘记前面说过什么，但每一轮都要把这些字重新读一遍。
            </p>

            {/* ★ 拉到上限时必须明示倍数（§6 截断策略第 2 条）。
               这里刻意不写"还能聊多少轮"—— 前端拿不到余额换算，编出来的数字
               比不写更糟；要精确轮数去额度页看真实流水。 */}
            {atMax && carry > defaultCarry ? (
              <p className="cost-alert" role="status">
                <IconWarning size={16} />
                <span>
                  你拉到了这档的上限。这样每轮消耗大约是默认设置的{' '}
                  <b>{multiplier.toFixed(1)} 倍</b> —— 同样一份额度，能聊的轮数会相应减少。
                  想记更久就留着，想聊更久就往回调一点。
                </span>
              </p>
            ) : null}
          </section>

          {/* ── 实时读数 ───────────────────────────── */}
          <dl className="cost-readout">
            <div><dt>本轮预计输入</dt><dd>{est.tokens.toLocaleString()} token</dd></div>
            <div><dt>其中携带历史</dt><dd>{fmtTokens(carry)}</dd></div>
            <div><dt>本轮预计消耗</dt><dd>{est.yuan.toFixed(4)} 元</dd></div>
            <div><dt>相对默认</dt><dd className={multiplier > 1.5 ? 'cost-up' : undefined}>{`×${multiplier.toFixed(2)}`}</dd></div>
          </dl>

          {/* ── 召回条数 ───────────────────────────── */}
          <section className="cost-block">
            <div className="row cost-label-row">
              <label htmlFor="recall" className="cost-label">TA 主动想起几件旧事</label>
              <span className="cost-value">{recall} 条<span className="cost-todo">待接入</span></span>
            </div>
            <input
              id="recall" type="range" min={0} max={Math.max(4, e.recall_topk)} step={1}
              value={recall} disabled={!sessionId}
              onChange={(ev) => setRecall(Number(ev.target.value))}
            />
            <p className="muted cost-hint">
              0 条最省，但 TA 就不会主动提到你们以前的事。档位最高到 {e.recall_topk} 条。
            </p>
          </section>

          {/* ── 输出长度 ───────────────────────────── */}
          <section className="cost-block">
            <div className="row cost-label-row">
              <span className="cost-label">TA 一次说多长<span className="cost-todo">待接入</span></span>
            </div>
            <div className="row cost-seg" role="group" aria-label="输出长度">
              {OUTPUT_CHOICES.map((o) => (
                <button
                  key={o.key} type="button"
                  className={`chip${output === o.key ? ' chip-on' : ''}`}
                  aria-pressed={output === o.key}
                  onClick={() => setOutput(o.key)}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <p className="muted cost-hint">{OUTPUT_CHOICES.find((o) => o.key === output)?.hint}</p>
          </section>

          {/* ── 省额度模式 ─────────────────────────── */}
          <section className="cost-block cost-eco">
            <label className="row cost-switch">
              <input
                type="checkbox" checked={eco} disabled={!sessionId}
                onChange={(ev) => {
                  const on = ev.target.checked;
                  setEco(on);
                  if (on) { setCarry(Math.max(1024, Math.round(defaultCarry / 2))); setRecall(Math.max(2, Math.floor(e.recall_topk / 2))); }
                  else { setCarry(defaultCarry); setRecall(e.recall_topk); }
                }}
              />
              <span className="col">
                <b>省额度模式</b>
                <span className="muted">携带减半、召回减半。代价是 TA 更容易忘事，换来大约三倍的轮数。</span>
              </span>
            </label>
          </section>

          <div className="sheet-actions">
            <button
              type="button" className="btn"
              onClick={() => { setCarry(defaultCarry); setRecall(e.recall_topk); setOutput('normal'); setEco(false); }}
            >
              恢复这档的默认
            </button>
            <button
              type="button" className="btn btn-primary"
              disabled={!sessionId || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? '存…' : '用这套设置'}
            </button>
          </div>

          {!sessionId ? (
            <p className="muted cost-no-session">
              这些设置是跟着会话走的。打开一个对话之后再回来调，就能保存了。
            </p>
          ) : null}

          {/* ── 高级：诚实说明哪些还没接上 ─────────── */}
          <details className="cost-adv" onToggle={(ev) => setAdvanced((ev.currentTarget as HTMLDetailsElement).open)}>
            <summary>
              <IconChevronDown size={15} /> <span>为什么这些数字是这样算的</span>
            </summary>
            <div className="cost-adv-body">
              <table className="cost-table">
                <tbody>
                  <tr><th scope="row">固定前缀</th><td>{fmtTokens(PREFIX_TOKENS)}</td><td className="muted">产品说明与安全规则，不动它才能命中缓存</td></tr>
                  <tr><th scope="row">携带历史</th><td>{fmtTokens(carry)}</td><td className="muted">成本大头，就是上面那个滑杆</td></tr>
                  <tr><th scope="row">回忆片段</th><td>{fmtTokens(recall * RECALL_PER_ITEM)}</td><td className="muted">每条约 300 token</td></tr>
                  <tr><th scope="row">TA 的输出</th><td>{fmtTokens(OUTPUT_CHOICES.find((o) => o.key === output)?.tokens ?? 800)}</td><td className="muted">按最长情况估</td></tr>
                </tbody>
              </table>
              <p className="muted">
                单价按 ¥{YUAN_PER_M_TOKEN.toFixed(1)} / 百万 token 估，实际以服务商结算为准。
                用了你自己的 Key 时，这里显示的成本由你的账号承担，不扣本页面的额度。
              </p>
              <p className="muted">
                窗口上限 {fmtTokens(e.window_limit)}。携带量不能超过它，所以上面滑杆的最高点就是这个档位的天花板。
              </p>
              {/* ★ 诚实边界：目前只有携带量能存到服务端（sessions.carry_tokens →
                  patch_session）。召回条数与输出长度还没有 per-session 列，
                  在这里必须说清"暂时按档位默认走"，不能让用户以为调了就生效。 */}
              <p className="cost-honest">
                现在<b>只有携带量</b>会真的存下来并按会话生效。回忆条数和说话长度还在用档位默认值 ——
                服务端补上这两个字段之前，调它们不会影响实际消耗，所以我们把这一格标成待接入而不是假装能存。
              </p>
            </div>
          </details>
        </>
      ) : null}
    </div>
  );
}

// ── 估算 ───────────────────────────────────────────────
/**
 * 单轮输入量粗估。省额度模式不在这里打折 —— 它的实现方式就是把
 * carry 和 recall 直接调低，那才是它真的省钱的原因。
 */
function estimate(carry: number, recall: number, output: OutputKey) {
  const out = OUTPUT_CHOICES.find((o) => o.key === output)?.tokens ?? 800;
  const tokens = PREFIX_TOKENS + carry + recall * RECALL_PER_ITEM + out;
  return { tokens, yuan: (tokens / 1_000_000) * YUAN_PER_M_TOKEN };
}

function fmtTokens(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(n % 1024 === 0 ? 0 : 1)}K` : `${n}`;
}

/** 顶栏入口用的极简摘要：只显示当前携带量 */
export function CarryBadge({ sessionId }: { sessionId?: string }) {
  const { data } = useQuery({
    queryKey: ['session-carry', sessionId ?? ''],
    queryFn: async (): Promise<number | null> => {
      if (!sessionId) return null;
      const { data: d } = await supabase.from('sessions').select('carry_tokens').eq('id', sessionId).maybeSingle();
      return d?.carry_tokens ?? null;
    },
    enabled: Boolean(sessionId),
  });
  if (!data) return null;
  return <span className="chip chip-sm"><IconInfo size={13} /> 带 {fmtTokens(data)}</span>;
}
