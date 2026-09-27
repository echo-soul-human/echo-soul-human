/**
 * CreditPage.tsx — 额度页（余额 / 有效期 / 流水 / 档位 / 加量包 / 自助追账）
 *
 * 这一页是这个产品最难做诚实的地方。分册-模型与计费 §8 的原话：
 *   "抖音第一痛点是 Token 太贵养不起。所以不要藏成本，要把它做成产品功能。"
 * 所以：
 *   · 余额、冻结中、已消耗三个数必须同时出现 —— 只给一个数等于让人猜。
 *   · 额度**有效期**要显式写日期并倒计时（19 号专篇 §4），过期作废这件事不能藏在条款里。
 *   · "我付了但没到账"必须是页内按钮走 claim_order，而不是"联系客服"
 *     （17 号专篇 §7：这个品类没有客服，找客服本身就是流失点）。
 *
 * 数据来源全部 TanStack Query：my_credit / ledger / order_history / plan_catalog。
 */
import { useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { supabase } from '../../lib/supabase';
import { claimOrder, keys, myCredit, toMessage, type ClaimResult, type CreditInfo } from '../rpc';
import { Empty } from '../../ui/Empty';
import { Sheet } from '../../ui/Sheet';
import { SkeletonRows } from '../../ui/Skeleton';
import { toast } from '../../ui/Toast';
import { IconCoins, IconRefresh } from '../../ui/icons';
import { ROW_ESTIMATE_PX } from '../../ui/tokens';

/** 档位 → 每日可用轮数（分册-模型与计费 §7 的限频表）；单位是"元"还是"轮"要说清 */
const TIER_ROUNDS: Record<string, string> = {
  free: '每小时 20 轮', lite: '每小时 60 轮', pro: '每小时 200 轮',
  pro_plus: '每小时 400 轮', ultra: '每小时 800 轮',
};
const TIER_CARRY: Record<string, string> = {
  free: '8K', lite: '16K', pro: '48K', pro_plus: '128K', ultra: '512K',
};
const TIER_LABEL_CN: Record<string, string> = {
  free: '体验档', lite: 'Lite', pro: 'Pro', pro_plus: 'Pro+', ultra: 'Ultra',
};

interface LedgerRow {
  id: number;
  type: string;
  amount: number;
  reason: string | null;
  ref_kind: string | null;
  created_at: string;
}

interface PlanRow {
  id: string;
  tier: string;
  price_cny: number;
  grant_credit: number;
  valid_days: number;
  credit_valid_days: number;
  is_addon: boolean;
  is_annual: boolean;
}

const LEDGER_LABEL: Record<string, { name: string; sign: '+' | '-' | '' }> = {
  freeze: { name: '预扣（正在生成）', sign: '-' },
  settle: { name: '实际消耗', sign: '-' },
  refund: { name: '退回', sign: '+' },
  grant: { name: '赠送额度', sign: '+' },
  purchase: { name: '购买到账', sign: '+' },
  adjust: { name: '人工调整', sign: '+' },
  byok_usage: { name: '用自己的 Key（不扣这里）', sign: '' },
  tts_grant: { name: '朗读额度入账', sign: '+' },
  tts_consume: { name: '朗读消耗', sign: '-' },
  tts_refund: { name: '朗读退回', sign: '+' },
};

export function CreditPage() {
  const [claimOpen, setClaimOpen] = useState(false);

  const credit = useQuery({ queryKey: keys.credit, queryFn: myCredit });
  const plans = useQuery({
    queryKey: keys.plans,
    queryFn: async (): Promise<PlanRow[]> => {
      const { data, error } = await supabase.from('plan_catalog')
        .select('id,tier,price_cny,grant_credit,valid_days,credit_valid_days,is_addon,is_annual')
        .eq('active', true)
        .order('price_cny');
      if (error) throw new Error(toMessage(error.code, error.message));
      return (data ?? []) as PlanRow[];
    },
  });

  const flows = useInfiniteQuery({
    queryKey: keys.ledger,
    initialPageParam: undefined as number | undefined,
    queryFn: async ({ pageParam }): Promise<{ rows: LedgerRow[]; next?: number | undefined }> => {
      let q = supabase.from('ledger')
        .select('id,type,amount,reason,ref_kind,created_at')
        // 只看会影响余额的条目：freeze/settle 成对出现会把列表撑爆
        .in('type', ['settle', 'refund', 'grant', 'purchase', 'adjust', 'byok_usage', 'tts_consume'])
        .order('id', { ascending: false })
        .limit(30);
      if (pageParam !== undefined) q = q.lt('id', pageParam);
      const { data, error } = await q;
      if (error) throw new Error(toMessage(error.code, error.message));
      const rows = (data ?? []) as LedgerRow[];
      return { rows, ...(rows.length === 30 ? { next: rows.at(-1)?.id } : {}) };
    },
    getNextPageParam: (last) => last.next,
  });

  const rows = useMemo(() => flows.data?.pages.flatMap((p) => p.rows) ?? [], [flows.data]);

  return (
    <div className="credit-page">
      <header className="panel-head">
        <h3>额度</h3>
        <p className="muted panel-sub">这里显示的是我们这边的额度。用了你自己的 Key，那一轮不会从这里扣。</p>
      </header>

      {credit.isLoading ? <SkeletonRows count={2} h={92} gap={10} /> : null}
      {credit.isError ? (
        <p className="cd-notice cd-notice-bad" role="alert">
          余额没读到。<button type="button" className="btn btn-ghost" onClick={() => void credit.refetch()}>再试一次</button>
        </p>
      ) : null}

      {credit.data ? <BalanceCard c={credit.data} onClaim={() => setClaimOpen(true)} /> : null}

      <PlansTable plans={plans.data ?? []} loading={plans.isLoading} currentTier={credit.data?.tier} />

      <section className="credit-section">
        <h4 className="sec-title">消耗流水</h4>
        <p className="muted sec-sub">每条都是一笔真实的账。数字以「元」计，保留四位小数 —— 不做四舍五入到好看的位数。</p>

        {flows.isLoading ? <SkeletonRows count={4} h={ROW_ESTIMATE_PX - 16} gap={6} /> : null}
        {flows.isError ? <p className="muted">流水加载失败。</p> : null}
        {!flows.isLoading && rows.length === 0 ? (
          <Empty title="还没有消耗记录" hint="聊一轮就会有一条。" icon={<IconCoins />} />
        ) : null}

        {rows.length > 0 ? <FlowList rows={rows} hasNext={Boolean(flows.hasNextPage)} fetchMore={() => void flows.fetchNextPage()} busy={flows.isFetchingNextPage} /> : null}
      </section>

      {claimOpen ? <ClaimSheet onClose={() => setClaimOpen(false)} /> : null}
    </div>
  );
}

// ── 余额卡 ─────────────────────────────────────────────
function BalanceCard({ c, onClaim }: { c: CreditInfo; onClaim: () => void }) {
  const expiry = c.credit_expiry ? daysLeft(c.credit_expiry) : null;
  return (
    <section className="balance-card">
      <div className="row balance-top">
        <div className="col grow">
          <span className="muted balance-label">还能用</span>
          <span className="balance-num">{c.usable.toFixed(4)}</span>
        </div>
        <span className="cd-badge">{TIER_LABEL_CN[c.tier] ?? c.tier}</span>
      </div>

      <dl className="balance-grid">
        <div><dt>入账合计</dt><dd>{c.granted.toFixed(4)}</dd></div>
        <div><dt>已消耗</dt><dd>{c.spent.toFixed(4)}</dd></div>
        {/* 冻结中必须显示：它意味着"有一轮正在生成，钱已经预定出去了"，
            用户看到余额比预期少时唯一的解释入口 */}
        <div><dt>占用中</dt><dd>{c.frozen > 0 ? c.frozen.toFixed(4) : '—'}</dd></div>
        <div><dt>剩余朗读字数</dt><dd>{Math.max(0, Math.round(c.tts_remaining))}</dd></div>
      </dl>

      <p className={`balance-expiry${expiry !== null && expiry <= 7 ? ' balance-expiry-soon' : ''}`}>
        {c.credit_expiry
          ? <>额度有效期至 <b>{fmtDate(c.credit_expiry)}</b>{expiry !== null ? `（还剩 ${expiry} 天）` : ''}。过期后未用完的部分作废，不会顺延。</>
          : '当前档位没有到期时间。'}
      </p>
      {c.expires_at ? (
        <p className="muted balance-tier-expiry">
          档位到期：{fmtDate(c.expires_at)}。档位到期不影响已有额度的可用性，但不再有档位专属权益。
        </p>
      ) : null}

      <div className="row balance-actions">
        <a className="btn btn-primary" href={afdianUrl()} target="_blank" rel="noopener noreferrer">续额度</a>
        {/* 17 号专篇 §7：付了没到账走页内自助，不引导客服 */}
        <button type="button" className="btn" onClick={onClaim}>
          <IconRefresh size={15} /> <span>我付了但没到账</span>
        </button>
      </div>
    </section>
  );
}

// ── 档位对比 + 加量包 ───────────────────────────────────
function PlansTable({ plans, loading, currentTier }: { plans: PlanRow[]; loading: boolean; currentTier?: string | undefined }) {
  const subs = plans.filter((p) => !p.is_addon);
  const addons = plans.filter((p) => p.is_addon);

  if (loading) return <SkeletonRows count={3} h={64} gap={6} />;
  if (!subs.length) return null;

  return (
    <section className="credit-section">
      <h4 className="sec-title">档位对比</h4>
      <p className="muted sec-sub">
        决定"能记多少、聊多久"的是携带量和召回条数，不是价格。表里的携带量指每轮最多带多少历史。
      </p>

      <div className="plan-scroll scroll-pane-x">
        <table className="plan-table">
          <thead>
            <tr>
              <th scope="col">档位</th>
              <th scope="col">价格</th>
              <th scope="col">随附额度</th>
              <th scope="col">额度有效</th>
              <th scope="col">携带历史</th>
              <th scope="col">频率</th>
            </tr>
          </thead>
          <tbody>
            {subs.map((p) => (
              <tr key={p.id} className={p.tier === currentTier ? ' plan-current' : undefined}>
                <th scope="row">
                  {TIER_LABEL_CN[p.tier] ?? p.tier}
                  {p.is_annual ? <span className="muted plan-annual">年</span> : null}
                  {p.tier === currentTier ? <span className="plan-tag">当前</span> : null}
                </th>
                <td>¥{Number(p.price_cny).toFixed(0)}</td>
                <td>{Number(p.grant_credit).toFixed(2)}</td>
                <td>{p.credit_valid_days} 天</td>
                <td>{TIER_CARRY[p.tier] ?? '—'}</td>
                <td>{TIER_ROUNDS[p.tier] ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {addons.length > 0 ? (
        <>
          <h4 className="sec-title">加量包</h4>
          <p className="muted sec-sub">
            只加额度、不改档位：携带量和召回条数按现在这档算。加量包的额度有效期固定 372 天，比订阅长。
          </p>
          <ul className="addon-list">
            {addons.map((p) => (
              <li key={p.id} className="addon-item">
                <div className="grow col">
                  <b>{Number(p.grant_credit).toFixed(0)} 额度</b>
                  <span className="muted">有效 {p.credit_valid_days} 天 · 不动档位</span>
                </div>
                <a className="btn" href={afdianUrl(p.id)} target="_blank" rel="noopener noreferrer">¥{Number(p.price_cny).toFixed(0)}</a>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

// ── 流水（虚拟化）──────────────────────────────────────
function FlowList({ rows, hasNext, fetchMore, busy }: {
  rows: LedgerRow[]; hasNext: boolean; fetchMore: () => void; busy: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => ref.current,
    estimateSize: () => 52,
    overscan: 8,
  });

  return (
    <>
      <div ref={ref} className="flow-scroll scroll-pane" style={{ maxHeight: '46dvh' }}>
        <div style={{ height: virt.getTotalSize(), position: 'relative', width: '100%' }}>
          {virt.getVirtualItems().map((item) => {
            const r = rows[item.index];
            if (!r) return null;
            const meta = LEDGER_LABEL[r.type] ?? { name: r.type, sign: '' as const };
            return (
              <div
                key={r.id}
                data-index={item.index}
                ref={virt.measureElement}
                className="flow-row"
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}
              >
                <span className="flow-date muted">{fmtDate(r.created_at)}</span>
                <span className="grow col">
                  <span className="flow-name">{meta.name}</span>
                  {r.reason ? <span className="muted flow-reason">{reasonText(r)}</span> : null}
                </span>
                <span className={`flow-amt flow-${meta.sign}`}>
                  {meta.sign === '' ? '—' : `${meta.sign}${Number(r.amount).toFixed(4)}`}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {hasNext ? (
        <button type="button" className="btn btn-ghost flow-more" disabled={busy} onClick={fetchMore}>
          {busy ? '加载中…' : '看更早的'}
        </button>
      ) : (
        <p className="muted flow-end">到这里就是全部了。</p>
      )}
    </>
  );
}

/**
 * reason 字段是服务端写的机器语言（freeze_remainder / model_error / 订单号），
 * 直接显示等于让用户读日志。
 */
function reasonText(r: LedgerRow): string {
  switch (r.reason) {
    case 'freeze_remainder': return '这轮实际用得比预扣少，差额退回来了';
    case 'model_error': return '生成失败，全额退回';
    case 'stream_break': return '中途断了，只按已生成的部分收';
    default: return r.reason ?? '';
  }
}

// ── "我付了但没到账" ───────────────────────────────────
function ClaimSheet({ onClose }: { onClose: () => void }) {
  const [no, setNo] = useState('');
  const [result, setResult] = useState<ClaimResult | null>(null);

  const claim = useMutation({
    mutationFn: () => claimOrder(no.trim()),
    onSuccess: (r) => {
      setResult(r);
      if (r.ok && r.matched) toast.ok('找到了，两分钟内到账');
    },
    onError: (e: Error) => setResult({ ok: false, code: 'ERR', note: e.message }),
  });

  return (
    <Sheet title="我付了但没到账" onClose={onClose} dirty={no.length > 0}>
      <div className="col claim-form">
        <p>
          把爱发电的<b>订单号</b>填进来，系统会重新做一次归因。整个过程不需要联系客服。
        </p>
        <p className="muted field-hint">
          订单号在爱发电的「我的订单」里，是一串字母数字。至少 8 位。
        </p>

        <div className="field">
          <label htmlFor="cl-no">订单号</label>
          <input
            id="cl-no" data-autofocus value={no} maxLength={64} spellCheck={false}
            autoComplete="off" placeholder="比如：2026092712345678"
            onChange={(e) => { setNo(e.target.value); setResult(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && no.trim().length >= 8) claim.mutate(); }}
          />
        </div>

        {result ? (
          <p className={`claim-result${result.matched ? ' claim-ok' : ' claim-warn'}`} role="status">
            {result.note ?? (result.ok ? '已经提交重查。' : '这次没能处理，稍后再试。')}
          </p>
        ) : null}

        {result?.ok && !result.matched ? (
          <ul className="muted claim-tips">
            <li>刚付完不到 2 分钟的话，正常流程还在跑，等一下再回来看。</li>
            <li>确认一下付款用的爱发电账号是不是你登录这里的这个 —— 换过一次邮箱是最常见的原因。</li>
            <li>订单号抄错一位也不会匹配，可以再核对一遍重新提交。</li>
          </ul>
        ) : null}

        <div className="sheet-actions">
          <button type="button" className="btn" onClick={onClose}>关掉</button>
          <button
            type="button" className="btn btn-primary"
            disabled={no.trim().length < 8 || claim.isPending}
            onClick={() => claim.mutate()}
          >
            {claim.isPending ? '重查中…' : '帮我查一下'}
          </button>
        </div>

        <p className="muted claim-limit">一分钟最多提交 3 次，这是防止别人拿你的订单号乱试。</p>
      </div>
    </Sheet>
  );
}

/** 爱发电页面：project id 由部署侧环境变量给，缺省时回落到主页而不是报错 */
function afdianUrl(planRef?: string): string {
  const base = import.meta.env.VITE_AFDIAN_URL as string | undefined;
  const pid = import.meta.env.VITE_AFDIAN_PROJECT as string | undefined;
  if (!base || !pid) return 'https://ifdian.net';
  return planRef ? `${base.replace(/\/$/, '')}/${pid}?plan=${encodeURIComponent(planRef)}` : `${base.replace(/\/$/, '')}/${pid}`;
}

function daysLeft(iso: string): number | null {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86_400_000);
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 供其他页复用的余额角标（顶栏那个小数字） */
export function useCreditBadge(): { text: string; warn: boolean } {
  const { data } = useQuery({ queryKey: keys.credit, queryFn: myCredit });
  if (!data) return { text: '', warn: false };
  const soon = data.credit_expiry ? daysLeft(data.credit_expiry) : null;
  return {
    text: `${data.usable.toFixed(2)} 额度`,
    warn: data.usable < 1 || (soon !== null && soon <= 3),
  };
}
