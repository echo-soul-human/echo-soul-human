/**
 * _shared/limits.ts — 服务端权益判定
 *
 * ★ 所有档位限制必须在服务端判，客户端只能显示。
 *   理由很直白：客户端判等于没判，改一下本地存储就能白拿 Ultra。
 *   架构 §7 的"能进数据库的不放缓存，能在服务端算的不放前端"这条在这里落地。
 */
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export interface Limits {
  tier: string;
  expires_at: string | null;
  credit_expiry: string | null;
  character_slots: number;
  window_limit: number;
  carry_tokens: number;
  carry_default: number;
  recall_topk: number;
  group_member_max: number;
  skin_quota: number;
  sticker_quota: number;
  proactive_per_day: number;
  /** 每小时轮次上限，防脚本与薅羊毛 */
  rounds_per_hour: number;
  /** 输出上限 token */
  max_output: number;
  tts_chars_per_day: number;
  can_publish: boolean;
  can_byok: boolean;
  is_minors: boolean;
}

const FLOOR: Limits = {
  tier: 'free', expires_at: null, credit_expiry: null,
  character_slots: 1, window_limit: 262_144,
  carry_tokens: 8_192, carry_default: 8_192, recall_topk: 4,
  group_member_max: 2, skin_quota: 1, sticker_quota: 20,
  proactive_per_day: 0, rounds_per_hour: 20, max_output: 800,
  tts_chars_per_day: 0, can_publish: false, can_byok: false, is_minors: false,
};

/** 档位轮次上限（分册-模型与计费 §8）。免费档给到 20/时足够体验，再多就是被薅 */
const ROUNDS: Record<string, number> = {
  free: 20, lite: 60, pro: 200, pro_plus: 400, ultra: 800,
};
const TTS_CHARS: Record<string, number> = {
  free: 0, lite: 50_000, pro: 200_000, pro_plus: 600_000, ultra: 2_000_000,
};
const VOICE_LEVEL: Record<string, number> = {
  free: 0, lite: 1, pro: 2, pro_plus: 3, ultra: 3,
};

export interface LoadResult { limits: Limits; error: string | null }

export async function loadLimits(db: SupabaseClient, userId: string): Promise<LoadResult> {
  const { data, error } = await db.from('entitlements')
    .select(`tier, expires_at, credit_expiry, character_slots, window_limit,
             carry_tokens, carry_default, recall_topk, group_member_max,
             skin_quota, sticker_quota, proactive_per_day, tts_voice_profile`)
    .eq('user_id', userId).maybeSingle();

  if (error) return { limits: FLOOR, error: 'LEDGER_UNAVAILABLE' };
  if (!data) return { limits: FLOOR, error: 'NO_ENTITLEMENT' };

  const tier = String(data.tier ?? 'free');
  const expired = !!data.expires_at && new Date(data.expires_at) < new Date();
  // 会员过期 ⇒ 能力回落 Free，但**已消耗的额度与数据一律保留**（17 号专篇 §4.5）
  const effective = expired ? 'free' : tier;
  const base = expired ? FLOOR : data;

  const { data: prof } = await db.from('profiles').select('birth_declared').eq('id', userId).maybeSingle();
  const isMinors = isMinor(prof?.birth_declared);

  const limits: Limits = {
    tier: effective,
    expires_at: data.expires_at,
    credit_expiry: data.credit_expiry,
    character_slots: intOf(base.character_slots, FLOOR.character_slots),
    window_limit: intOf(base.window_limit, FLOOR.window_limit),
    carry_tokens: intOf(base.carry_tokens, FLOOR.carry_tokens),
    carry_default: intOf(base.carry_default, FLOOR.carry_default),
    recall_topk: intOf(base.recall_topk, FLOOR.recall_topk),
    group_member_max: intOf(base.group_member_max, FLOOR.group_member_max),
    skin_quota: intOf(base.skin_quota, FLOOR.skin_quota),
    sticker_quota: intOf(base.sticker_quota, FLOOR.sticker_quota),
    proactive_per_day: intOf(base.proactive_per_day, FLOOR.proactive_per_day),
    rounds_per_hour: ROUNDS[effective] ?? FLOOR.rounds_per_hour,
    max_output: effective === 'ultra' || effective === 'pro_plus' ? 1600 : 800,
    tts_chars_per_day: TTS_CHARS[effective] ?? 0,
    can_publish: VOICE_LEVEL[effective] >= 2,
    can_byok: !isMinors && VOICE_LEVEL[effective] >= 0 && effective !== 'free',
    is_minors: isMinors,
  };

  // 未成年人：BYOK 与主动关怀一律关（27 号专篇 §2.1）
  if (isMinors) {
    limits.can_byok = false;
    limits.proactive_per_day = 0;
    limits.group_member_max = Math.min(limits.group_member_max, 2);
    limits.can_publish = false;
  }

  return { limits, error: null };
}

/** 把用户手动调高的携带量夹到档位上限内 */
export function clampCarry(limits: Limits, requested?: number | null): number {
  const ceiling = limits.carry_tokens;
  const fallback = limits.carry_default || limits.carry_tokens;
  if (!requested || !Number.isFinite(requested)) return Math.min(fallback, ceiling);
  return Math.max(1024, Math.min(Math.trunc(requested), ceiling));
}

/** 召回条数夹到档位上限，超出静默截断而不是报错（对用户更友好） */
export function clampTopK(limits: Limits, requested?: number | null): number {
  if (!requested || !Number.isFinite(requested)) return limits.recall_topk;
  return Math.max(1, Math.min(Math.trunc(requested), limits.recall_topk));
}

export function intOf(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/** 满 18 才算成年人；生日缺失按成年人处理但会被前端要求补声明 */
export function isMinor(birth?: string | null): boolean {
  if (!birth) return false;
  const b = new Date(birth);
  if (Number.isNaN(b.getTime())) return false;
  const now = new Date();
  const age = (now.getTime() - b.getTime()) / (365.25 * 24 * 3600 * 1000);
  return age < 18;
}

/** 关系阶段：内层数值不可见，只有阶段进 prompt（架构 §4 规则 3） */
export const STAGES = ['stranger', 'acquainted', 'close', 'ambiguous', 'established'] as const;
export type Stage = typeof STAGES[number];

/** 阶段跃迁阈值。刻意保守 —— 一天最多变一次，缓存友好 */
export function stageForScore(score: number): Stage {
  if (score >= 900) return 'established';
  if (score >= 500) return 'ambiguous';
  if (score >= 240) return 'close';
  if (score >= 80) return 'acquainted';
  return 'stranger';
}
