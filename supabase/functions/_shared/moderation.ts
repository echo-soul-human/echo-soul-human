/**
 * _shared/moderation.ts — 内容处理规则
 *
 * 规则存在库里（sensitive_rules），后台可改、不需发版；
 * 用 rule_version 做进程内缓存失效，避免每轮对话都查一次表。
 *
 * ⚠ 边界（README「边界」一节，不因协议措辞而改变）：
 *   这一层做的是**平台自身**的内容处理 —— 未成年人保护、自伤、违法、导流诈骗。
 *   不提供"关闭上游模型过滤""解除限制"的任何开关。
 */
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type Scope = 'community' | 'proactive' | 'all';
export type Action = 'block' | 'replace' | 'flag' | 'review';

interface Rule {
  id: number;
  re: RegExp;
  action: Action;
  reason: string;
  scope: Scope;
}

let cache: { version: number; rules: Rule[] } | null = null;
let loading: Promise<Rule[]> | null = null;

const SCOPE_MATCH: Record<Scope, Scope[]> = {
  all: ['community', 'proactive', 'all'],
  community: ['community', 'all'],
  proactive: ['proactive', 'all'],
};

export async function rules(db: SupabaseClient): Promise<Rule[]> {
  const { data: v } = await db.from('rule_version').select('v').eq('id', 1).maybeSingle();
  const version = Number(v?.v ?? 0);
  if (cache && cache.version === version) return cache.rules;

  if (!loading) {
    loading = (async () => {
      try {
        const { data, error } = await db.from('sensitive_rules')
          .select('id,pattern,flags,scope,action,reason')
          .eq('enabled', true);
        if (error) return [];
        const out: Rule[] = [];
        for (const r of data ?? []) {
          try {
            out.push({
              id: Number(r.id),
              re: new RegExp(r.pattern, r.flags || 'i'),
              action: r.action as Action,
              reason: String(r.reason ?? ''),
              scope: r.scope as Scope,
            });
          } catch {
            // 规则写错不能拖垮整条链路，跳过并留一行日志
            console.warn('[moderation] 跳过非法正则', String(r.id));
          }
        }
        cache = { version, rules: out };
        return out;
      } finally {
        loading = null;
      }
    })();
  }
  return loading;
}

export interface Verdict {
  clean: boolean;
  action: Action;
  reason: string;
  ruleIds: number[];
}

const CLEAN: Verdict = { clean: true, action: 'block', reason: '', ruleIds: [] };

/**
 * 判定一段文本。scope 决定用哪批规则：
 *   community  ⇒ 要公开的内容，最严
 *   proactive  ⇒ 角色主动发的消息
 *   all        ⇒ 两者都管
 */
export async function inspect(
  db: SupabaseClient, text: string, scope: 'community' | 'proactive',
): Promise<Verdict> {
  const t = String(text ?? '');
  if (!t.trim()) return CLEAN;

  const wanted = SCOPE_MATCH[scope];
  const all = await rules(db);
  const hit = all.filter((r) => wanted.includes(r.scope) && r.re.test(t));
  if (!hit.length) return CLEAN;

  // 取最严重的：block > review > flag > replace
  const rank: Record<Action, number> = { block: 3, review: 2, flag: 1, replace: 0 };
  const worst = hit.reduce((a, b) => (rank[b.action] > rank[a.action] ? b : a));
  return {
    clean: false,
    action: worst.action,
    reason: worst.reason || '内容不符合社区规则',
    ruleIds: hit.map((r) => r.id),
  };
}

/** 命中规则计数，供后台看哪条规则误杀率高（25 号专篇 §7.2） */
export async function bumpHits(db: SupabaseClient, ids: number[]): Promise<void> {
  if (!ids.length) return;
  try {
    // 自增必须走 SQL 侧，读改写会有并发丢失
    await db.rpc('bump_rule_hits', { p_ids: ids });
  } catch { /* 统计失败绝不影响主流程 */ }
}

/**
 * 危机信号识别。这不是"内容违规"，是**要不要给现实求助入口**。
 * 判定保守：宁可漏报也不要把用户的正常倾诉当成危机处理，
 * 但一旦命中就走 13 号专篇 §5 的处置。
 */
const CRISIS = [
  /不想活|活不下去|去死|自杀|结束(自己|生命)|一了百了/,
  /割腕|吞(药|下)|跳(楼|桥)|烧炭/,
  /杀(了|死)(他|她|它|对方|某人)/,
  /伤害(自己|自身)/,
];

export function crisisSignal(text: string): boolean {
  const t = String(text ?? '');
  return CRISIS.some((re) => re.test(t));
}

/** 涉未成年人的性化内容：零容忍，命中即 block 并留证（27 号专篇 §6.2） */
const MINOR_SEXUAL = [
  /(萝莉|幼女|正太|小学生|初中生|高中生|未成年).{0,12}(裸|脱|床|射|舔|摸|性|高潮|胸部|大腿)/,
  /(裸|脱|射|舔|摸|性|高潮).{0,12}(萝莉|幼女|正太|小学生|初中生|高中生|未成年)/,
];

export function minorSexual(text: string): boolean {
  const t = String(text ?? '');
  return MINOR_SEXUAL.some((re) => re.test(t));
}

/** 联系方式与外部收款导流（社区内容里最容易招来诈骗的一类） */
const CONTACT_SMUGGLE = [
  /加\s*(我|群|微信|vx|wx|qq|威信)/i,
  /(私\s*聊|私信|扫码|二维码)/,
  /(代充|低价会员|内部渠道|解封)/,
  /(1[3-9]\d{9})|([a-z0-9_-]{5,}@(?:qq|163|gmail|outlook)\.)/i,
  /(afdian|ifdian|爱发电)\.net\/[a-z0-9_-]+/i,
];

export function contactSmuggling(text: string): boolean {
  const t = String(text ?? '');
  return CONTACT_SMUGGLE.some((re) => re.test(t));
}

/** 疑似真实个人信息：发布前提示用户自查（本地判，不上传、不拦截） */
export function looksLikePII(text: string): string[] {
  const t = String(text ?? '');
  const flags: string[] = [];
  if (/1[3-9]\d{9}/.test(t)) flags.push('手机号');
  if (/\d{17}[\dXx]/.test(t)) flags.push('证件号码');
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(t)) flags.push('邮箱');
  if (/(身份证|银行卡|护照)\s*[:：]?\s*\w{6,}/.test(t)) flags.push('证件/卡号');
  return flags;
}
