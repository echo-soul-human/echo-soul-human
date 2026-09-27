/**
 * _shared/fulfil.ts — 订单 → 权益的幂等发放（webhook 与轮询共用）
 *
 * 为什么必须共用一份：文档明确「webhook 不保证及时送达，建议结合 API」。
 * 两条路各自写发放逻辑，早晚会出现一条发了、另一条重复发。
 *
 * 幂等三层：
 *   1. orders.external_id 唯一约束（数据库层）
 *   2. grant_credit RPC 的 (user,type,ref_kind,ref_id) 查重（账本层）
 *   3. 本函数的 select-for-update 序列（并发层）
 *
 * 有效期规则（docs/分册-模型与计费.md §5.3）：
 *   expires_at = greatest(现值, now) + valid_days
 *   ⇒ 未到期再买是**顺延**，不是覆盖。做错必被投诉。
 */
import { attributeOrder, type AfdianOrder } from './afdian.ts';
import { safeMessage } from './providers/openai.ts';

export interface FulfilResult {
  status: 'granted' | 'duplicate' | 'unmatched' | 'failed';
  userId?: string;
  orderId?: string;
  reason?: string;
  via?: string;
}

export async function fulfilOrder(
  supabase: any,
  order: AfdianOrder,
  source: 'webhook' | 'poll',
  log: (...a: unknown[]) => void = console.log,
): Promise<FulfilResult> {
  const externalId = order.out_trade_no;
  if (!externalId) return { status: 'failed', reason: 'no_out_trade_no' };

  // 1. 已处理过 ⇒ 直接返回（重复推送防线）
  const { data: existing } = await supabase
    .from('orders').select('id, status').eq('external_id', externalId).maybeSingle();
  if (existing && existing.status === 'granted') {
    return { status: 'duplicate', orderId: existing.id };
  }

  // 2. 归因
  const attr = await attributeOrder(supabase, order);
  if (!attr.ok) {
    await recordUnmatched(supabase, order, attr.reason, source, log);
    return { status: 'unmatched', reason: attr.reason };
  }

  // 3. 落订单
  const { data: ord, error: ordErr } = await supabase.from('orders').upsert({
    external_id: externalId,
    user_id: attr.userId,
    afdian_user_id: order.user_id,
    plan_ref: attr.planId,
    afdian_plan_id: order.plan_id,
    amount_cny: order.total_amount,
    show_amount_cny: order.show_amount,
    product_type: order.product_type,
    order_status: order.status,
    remark: order.remark ?? '',
    custom_order_id: order.custom_order_id ?? '',
    source,
    status: 'pending',
  }, { onConflict: 'external_id' }).select('id').single();

  if (ordErr || !ord) {
    log('order upsert failed', safeMessage(ordErr?.message));
    return { status: 'failed', reason: 'order_insert' };
  }

  // 4. 权益顺延 + 额度发放
  const { data: plan } = await supabase.from('plan_catalog')
    .select('tier, grant_credit, valid_days, is_addon, credit_valid_days')
    .eq('id', attr.planId).single();
  if (!plan) return { status: 'failed', reason: 'plan_missing' };

  const okGrant = await grant(supabase, attr.userId, plan, externalId, log);
  if (!okGrant) return { status: 'failed', reason: 'grant_failed' };

  await supabase.from('orders').update({ status: 'granted', granted_at: new Date().toISOString() })
    .eq('id', ord.id);

  log('granted', source, attr.userId.slice(0, 8), externalId, plan.tier);
  return { status: 'granted', userId: attr.userId, orderId: ord.id, via: attr.via };
}

async function grant(supabase: any, userId: string, plan: any, externalId: string, log: (...a: unknown[]) => void) {
  // 额度（加量包与会员都发额度；Free 档买加量包不改 tier）
  if (Number(plan.grant_credit) > 0) {
    const { data, error } = await supabase.rpc('grant_credit', {
      p_user: userId,
      p_amount: plan.grant_credit,
      p_type: 'purchase',
      p_order: externalId,
      p_reason: plan.id,
    });
    if (error || !(data as any)?.ok) {
      log('grant_credit failed', safeMessage(error?.message ?? (data as any)?.code));
      return false;
    }
    // 加量包额度有效期独立于会员，用 credit_expiry 记录
    const { data: ent } = await supabase.from('entitlements').select('credit_expiry').eq('user_id', userId).single();
    const base = maxNow(ent?.credit_expiry);
    const next = new Date(base.getTime() + plan.credit_valid_days * 86400_000).toISOString();
    await supabase.from('entitlements').update({ credit_expiry: next }).eq('user_id', userId);
  }

  if (plan.is_addon) return true;   // 加量包不动档位

  // 档位：取现有未到期档位与新档位的较高者，有效期顺延
  const { data: cur } = await supabase.from('entitlements')
    .select('tier, expires_at').eq('user_id', userId).single();

  const base = maxNow(cur?.expires_at);
  const nextExpiry = new Date(base.getTime() + plan.valid_days * 86400_000).toISOString();

  const higher = rank(plan.tier) >= rank(cur?.tier ?? 'free');
  const newTier = higher ? plan.tier : cur!.tier;

  const { error } = await supabase.from('entitlements').update({
    tier: newTier,
    expires_at: nextExpiry,
    updated_at: new Date().toISOString(),
  }).eq('user_id', userId);
  if (error) { log('tier update failed', safeMessage(error.message)); return false; }

  // 档位参数快照刷新（升档立即生效，降档不主动回收已购周期）
  await supabase.rpc('apply_tier', { p_user: userId, p_tier: newTier });
  await supabase.from('entitlements').update({ tier: newTier, expires_at: nextExpiry }).eq('user_id', userId);
  return true;
}

const RANK: Record<string, number> = { free: 0, lite: 1, pro: 2, pro_plus: 3, ultra: 4 };
const rank = (t?: string) => RANK[t ?? 'free'] ?? 0;

/** 顺延基准：未到期则从到期时间起算，已到期/为空则从现在起算 */
function maxNow(iso?: string | null): Date {
  if (!iso) return new Date();
  const d = new Date(iso);
  return d.getTime() > Date.now() ? d : new Date();
}

async function recordUnmatched(
  supabase: any, order: AfdianOrder,
  reason: string | undefined, source: string, log: (...a: unknown[]) => void,
) {
  try {
    await supabase.from('unmatched_orders').upsert({
      external_id: order.out_trade_no,
      afdian_user_id: order.user_id,
      afdian_plan_id: order.plan_id,
      amount_cny: order.total_amount,
      reason: reason ?? 'unknown',
      source,
      raw: order,
    }, { onConflict: 'external_id' });
  } catch (e) {
    log('unmatched record failed', safeMessage(e));
  }
  // 不打扰用户：不推送、不弹窗、不引导联系客服（用户定案：我不找客服）
}
