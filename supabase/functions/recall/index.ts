/**
 * functions/recall — 记忆检索的 HTTP 门
 *
 * 检索本体是 SQL 侧的 `recall()`（migrations/005_memory.sql），已经过验收。
 * 这一层只做四件 SQL 做不了的事：
 *   1. 鉴权 —— 只允许查自己的记忆，且角色必须是自己会话里的角色
 *   2. top_k 夹取 —— 用 clampTopK 按档位封顶，客户端传多大都没用
 *   3. 向量通道 —— 没配 embedding 服务时 p_vec 传 null，SQL 侧自动只剩关键词通道
 *   4. 回写召回统计 —— mark_recalled 只对 authenticated 开放了 delete_* 系列，
 *      这里用 service_role 补上（它决定 salience 的时间加成）
 *
 * ★ 不往响应里回任何 prompt 内容；source_msg_ids 一并给出，
 *   供"这条记忆是从哪句话来的"UI 使用（docs/分册-后端与数据库.md §6）。
 */
import { body, json, ok, preflight, requireUser, safe } from '../_shared/http.ts';
import { clampTopK, loadLimits } from '../_shared/limits.ts';
import { embedAvailable, embedTexts, literalFor } from '../_shared/embed.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

interface ReqBody {
  character_id?: string;
  session_id?: string;
  query?: string;
  top_k?: number;
}

const MAX_QUERY = 500;
/** 单次调用能查的角色数上限：群聊一轮最多几个座位，超了就是有人在扫库 */
const MAX_CHARS = 8;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return json(405, { error: 'METHOD_NOT_ALLOWED' });

  const b = await body<ReqBody>(req);
  if (!b) return json(400, { error: 'BAD_JSON' });

  const authed = await requireUser(req);
  if (!authed) return json(401, { error: 'UNAUTHORIZED' });
  const db = authed.db as unknown as SupabaseClient;
  const userId = authed.user.id;

  const query = String(b.query ?? '').trim().slice(0, MAX_QUERY);
  if (!query) return json(400, { error: 'EMPTY_QUERY' });

  const { limits, error: limErr } = await loadLimits(db, userId);
  if (limErr) return json(500, { error: 'LEDGER_UNAVAILABLE' });
  const topk = clampTopK(limits, Number(b.top_k));

  // 角色范围：显式给了就只查那一个；否则查该会话（或该用户全部会话）里的角色。
  // ★ 一律经 session_members 收敛，绝不接受"任意 character_id 直接查"。
  const charIds = await resolveCharacters(db, userId, b, authed.deviceId);
  if (!charIds.length) return ok({ memories: [], degraded: null, topk });
  if (charIds.length > MAX_CHARS) return json(400, { error: 'TOO_MANY_CHARACTERS' });

  // 向量通道：可选依赖，拿不到就留 null（chat 里同一个降级口径）
  let vecLiteral: string | null = null;
  let degraded: string | null = null;
  if (embedAvailable()) {
    const r = await embedTexts([query]);
    vecLiteral = literalFor(r, query);
    if (!vecLiteral) degraded = `embedding:${r.failure ?? 'empty'}`;
  } else {
    degraded = 'embedding:not-configured';
  }

  const out: Array<Record<string, unknown>> = [];
  for (const cid of charIds) {
    try {
      const { data, error } = await db.rpc('recall', {
        p_user: userId,
        p_char: cid,
        p_query: query,
        p_vec: vecLiteral,
        p_topk: topk,
      });
      if (error) {
        console.warn('[recall] rpc failed', userId.slice(0, 8), safe(error.message));
        degraded = 'recall:keyword-only';
        continue;
      }
      for (const row of data ?? []) {
        out.push({
          id: row.id,
          character_id: cid,
          kind: row.kind,
          text: row.text,
          score: row.score,
          vec_score: row.vec_score,
          kw_score: row.kw_score,
          source_message_ids: row.source_msg_ids ?? [],
        });
      }
    } catch (e) {
      // 检索失败对外不是错误：只是这次没想起东西来
      console.warn('[recall] threw', userId.slice(0, 8), safe(e));
      degraded = 'recall:unavailable';
    }
  }

  out.sort((a, c) => Number(c.score ?? 0) - Number(a.score ?? 0));
  const picked = out.slice(0, topk);

  // 召回统计回写：驱动 salience 的"近期被想起"加成。失败不影响本次返回。
  const ids = picked.map((m) => String(m.id)).filter(isUuid);
  if (ids.length) {
    try { await db.rpc('mark_recalled', { p_ids: ids }); } catch { /* 统计而已 */ }
  }

  return ok({ memories: picked, topk, vector_used: !!vecLiteral, degraded });
});

// ─── 角色范围解析 ────────────────────────────────────────
async function resolveCharacters(
  db: SupabaseClient, userId: string, b: ReqBody, _deviceId: string,
): Promise<string[]> {
  const explicit = String(b.character_id ?? '').trim();
  const session = String(b.session_id ?? '').trim();

  if (session && isUuid(session)) {
    // 会话必须属于本人（messages/sessions 的归属判定在这里做完，不靠 RLS 兜底）
    const { data: own } = await db.from('sessions').select('id').eq('id', session).eq('user_id', userId).maybeSingle();
    if (!own) return [];
    const { data } = await db.from('session_members').select('character_id')
      .eq('session_id', session).order('seat').limit(MAX_CHARS);
    const ids = (data ?? []).map((r: any) => String(r.character_id)).filter(isUuid);
    return explicit && isUuid(explicit) ? ids.filter((x) => x === explicit) : ids;
  }

  if (explicit && isUuid(explicit)) {
    // 没给会话时，要求该角色确实出现在本人任一会话中，否则等于开放任意角色探测
    const { data } = await db.from('session_members')
      .select('character_id,session_id').eq('character_id', explicit).limit(200);
    const mine = await ownsAnySession(db, userId, (data ?? []).map((r: any) => String(r.session_id)));
    return mine ? [explicit] : [];
  }

  // 都不给：查本人所有会话里的角色（记忆回顾页的默认视图）
  const { data: sessions } = await db.from('sessions').select('id').eq('user_id', userId).limit(50);
  const sids = (sessions ?? []).map((s: any) => s.id).filter(isUuid);
  if (!sids.length) return [];
  const { data } = await db.from('session_members').select('character_id').in('session_id', sids).limit(MAX_CHARS);
  return Array.from(new Set((data ?? []).map((r: any) => String(r.character_id)).filter(isUuid))).slice(0, MAX_CHARS);
}

async function ownsAnySession(db: SupabaseClient, userId: string, sessionIds: string[]): Promise<boolean> {
  const uniq = Array.from(new Set(sessionIds.filter(isUuid))).slice(0, 200);
  if (!uniq.length) return false;
  const { data } = await db.from('sessions').select('id').eq('user_id', userId).in('id', uniq).limit(1);
  return (data?.length ?? 0) > 0;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}
