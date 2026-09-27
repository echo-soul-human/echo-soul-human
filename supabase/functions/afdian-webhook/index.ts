/**
 * functions/afdian-webhook — 被动接收订单推送
 *
 * 契约（爱发电文档）：
 *   收到   { ec:200, em:'ok', data:{ type:'order', order:{...}, sign } }
 *   必须回 { "ec":200, "em":"" }，否则平台判定回调失败
 *   sign 用 RSA-SHA256 验，签名串 = out_trade_no + user_id + plan_id + total_amount
 *
 * 设计要点：
 *   · 验签失败 ⇒ 仍回 ec 200（重试不会让签名变正确），但记安全事件并告警
 *   · 发放失败 ⇒ 回 ec 500 让平台重试（幂等保证不会重复发）
 *   · 归因失败 ⇒ 回 ec 200，落 unmatched_orders，用户侧走自助重查
 *   · webhook 不保证送达 ⇒ 必须与 afdian-poll 并存，两者共用 fulfilOrder 的幂等逻辑
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verifyWebhookSign, type AfdianOrder } from '../_shared/afdian.ts';
import { fulfilOrder } from '../_shared/fulfil.ts';
import { safeMessage } from '../_shared/providers/openai.ts';

const ACK_OK = { ec: 200, em: '' };
const ACK_FAIL = { ec: 500, em: 'retry' };

function ok(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status, headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: { allow: 'POST, OPTIONS' } });
  if (req.method !== 'POST') return ok(ACK_OK);   // 探测请求不应触发平台重试

  let body: any;
  try {
    body = await req.json();
  } catch {
    return ok(ACK_FAIL);                            // 解析不了，让平台重投一次
  }

  const data = body?.data;
  const order = data?.order as AfdianOrder | undefined;

  if (data?.type !== 'order' || !order) {
    // 目前文档说 type 仅为 order；出现新类型时先确认收到，避免无意义重试
    console.warn('[afdian-webhook] 未识别的推送类型', String(data?.type));
    return ok(ACK_OK);
  }

  // ── 验签：不通过绝不发放 ──────────────────────────────
  const valid = await verifyWebhookSign(order, data?.sign);
  if (!valid) {
    console.error('[afdian-webhook] SIGNATURE INVALID', {
      out_trade_no: order.out_trade_no,
      plan_id: order.plan_id,
      // 只记摘要，绝不记 sign 与完整 body
    });
    await alertSecurity(order.out_trade_no);
    return ok(ACK_OK);   // 重试无意义，但必须确认收到以免平台封禁回调
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    const r = await fulfilOrder(supabase, order, 'webhook');
    if (r.status === 'failed') {
      console.error('[afdian-webhook] fulfil failed', r.reason, order.out_trade_no);
      return ok(ACK_FAIL);   // 让平台重试，幂等兜底
    }
    return ok(ACK_OK);
  } catch (e) {
    console.error('[afdian-webhook] threw', safeMessage(e));
    return ok(ACK_FAIL);
  }
});

/** 验签失败是安全信号：落一条后台可见的记录（不通知用户、不开工单） */
async function alertSecurity(externalId?: string) {
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    await supabase.from('admin_audit').insert({
      action: 'afdian_signature_invalid',
      target: externalId ?? '',
      detail: 'webhook 验签失败，已忽略且不发放',
      actor: 'system',
    });
  } catch {
    /* 告警本身失败不能再影响响应 */
  }
}
