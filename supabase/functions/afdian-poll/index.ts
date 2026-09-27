/**
 * functions/afdian-poll — 主动轮询订单（webhook 的兜底）
 *
 * 为什么必须有：爱发电文档原话「如果服务器异常，可能不保证能及时推送，
 * 因此建议结合 API 一起使用」。只靠 webhook，一次网络抖动就有人付了钱没到账，
 * 而这个产品**不做客服**，到账失败只能靠系统自己补上。
 *
 * 策略：
 *   · 每 60s 拉最近 3 页（新单一定在最前面，倒序分页）
 *   · 每晚一次深度扫描：把 unmatched_orders 里的单重新归因一遍
 *     （用户可能在那之后才用爱发电登录本服务，L1 绑定建立后就能自动到账）
 *   · 与 webhook 共用 fulfilOrder，幂等由 orders.external_id 唯一约束保证
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { AfdianClient, ORDER_PAID, type AfdianOrder } from '../_shared/afdian.ts';
import { fulfilOrder } from '../_shared/fulfil.ts';
import { safeMessage } from '../_shared/providers/openai.ts';

const PAGES_PER_RUN = 3;
const PER_PAGE = 100;
/** 深度扫描只回看这么多页，避免无限翻 */
const DEEP_PAGES = 20;

Deno.serve(async (req) => {
  const secret = Deno.env.get('CRON_SECRET');
  if (secret && req.headers.get('x-cron-secret') !== secret) {
    return new Response('forbidden', { status: 403 });
  }

  const url = new URL(req.url);
  const deep = url.searchParams.get('deep') === '1';

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  let client: AfdianClient;
  try {
    client = AfdianClient.fromEnv();
  } catch (e) {
    console.error('[afdian-poll] 未配置凭据', safeMessage(e));
    return json(500, { ok: false, error: 'NOT_CONFIGURED' });
  }

  const log = (...a: unknown[]) => console.log('[afdian-poll]', ...a);
  const stats = { scanned: 0, granted: 0, duplicate: 0, unmatched: 0, failed: 0, pages: 0 };

  try {
    if (deep) {
      await retryUnmatched(supabase, client, log, stats);
    } else {
      await pollRecent(supabase, client, log, stats);
    }
  } catch (e) {
    console.error('[afdian-poll] threw', safeMessage(e));
    return json(500, { ok: false, error: 'POLL_FAILED', stats });
  }

  return json(200, { ok: true, deep, ...stats });
});

async function pollRecent(supabase: any, client: AfdianClient, log: (...a: unknown[]) => void, stats: any) {
  for (let page = 1; page <= PAGES_PER_RUN; page++) {
    const res = await client.queryOrder({ page, per_page: PER_PAGE });
    stats.pages++;
    if (res.ec !== 200) {
      log('query-order 非 200', res.ec, res.em);
      return;
    }
    const list = res.data?.list ?? [];
    if (!list.length) return;

    for (const order of list) {
      if (order.status !== ORDER_PAID) continue;   // 只处理交易成功
      stats.scanned++;
      const r = await fulfilOrder(supabase, order as AfdianOrder, 'poll', log);
      bump(stats, r.status);
    }

    if (page >= (res.data?.total_page ?? 1)) return;
  }
}

/**
 * 深度扫描：把 unmatched_orders 里的单重新拉一遍归因。
 * 这是"用户先付款、后用爱发电登录"场景的唯一出路，
 * 也是 17 号专篇 §7 那个"我付了但没到账"按钮背后的实际动作。
 */
async function retryUnmatched(supabase: any, client: AfdianClient, log: (...a: unknown[]) => void, stats: any) {
  const { data: pending } = await supabase.from('unmatched_orders')
    .select('external_id').eq('resolved', false).order('created_at', { ascending: true }).limit(500);

  const ids: string[] = (pending ?? []).map((r: any) => r.external_id).filter(Boolean);
  if (!ids.length) { log('无待重查订单'); return; }

  // 文档支持 out_trade_no 逗号分隔批量查
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const res = await client.queryOrder({ out_trade_no: chunk.join(',') });
    if (res.ec !== 200) { log('batch query 非 200', res.ec); continue; }
    for (const order of res.data?.list ?? []) {
      stats.scanned++;
      const r = await fulfilOrder(supabase, order as AfdianOrder, 'poll', log);
      bump(stats, r.status);
      if (r.status === 'granted' || r.status === 'duplicate') {
        await supabase.from('unmatched_orders')
          .update({ resolved: true, resolved_at: new Date().toISOString() })
          .eq('external_id', order.out_trade_no);
      }
    }
  }
  log('深度扫描完成', `待重查 ${ids.length} 条`);
}

function bump(stats: any, status: string) {
  if (status === 'granted') stats.granted++;
  else if (status === 'duplicate') stats.duplicate++;
  else if (status === 'unmatched') stats.unmatched++;
  else stats.failed++;
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
