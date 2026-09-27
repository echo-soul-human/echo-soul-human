/**
 * functions/chat-resume — 断线续接（不重新生成）
 *
 * 为什么必须有：docs/分册-网页端.md §7.3 的第 3 条规矩 —— 
 *   「断线要能续，带 message_id 续接，不重新生成（重新生成会重复扣费）」。
 * 用户在地铁里断了一次网，回来应该看到那半句话被补完，而不是
 * 重新发一遍、再被扣一次钱。
 *
 * 三种状态，各自的处理（对齐 docs/分册-模型与计费.md §9 的流中断行）：
 *   · partial=false ⇒ 内容已完整落库，一次性回吐 + done(replay=true)
 *   · partial=true  ⇒ 流中断但账已在 chat 里结过（已产出部分按折扣认），
 *                     这里只负责把已有内容交付出去，**绝不二次扣费、也不退款**
 *   · 仍在生成      ⇒ 账本还没有该 request 的任何结算 ⇒ 轮询等它落地，
 *                     最长 20s；拿不到就按当前快照回吐 + error(partial=true)，
 *                     让客户端保留已显示内容并出「继续」按钮
 *
 * ★ SSE 帧格式与 chat 完全一致：meta / delta / done / error，
 *   字段表来自 shared/contract/api.json，客户端用的是同一个 consume()。
 */
import { body, json, preflight, requireUser, safe } from '../_shared/http.ts';

interface ReqBody {
  message_id?: string;
}

const WAIT_MS = 20_000;
const POLL_MS = 1_000;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return json(405, { error: 'METHOD_NOT_ALLOWED' });

  const b = await body<ReqBody>(req);
  if (!b) return json(400, { error: 'BAD_JSON' });

  const messageId = String(b.message_id ?? '').trim();
  if (!isUuid(messageId)) return json(400, { error: 'BAD_MESSAGE_ID' });

  const authed = await requireUser(req);
  if (!authed) return json(401, { error: 'UNAUTHORIZED' });
  const { db, user } = authed as unknown as { db: any; user: { id: string } };

  // ★ 必须属于调用者：RLS 之外的第二道锁，且顺带把 role 卡死在 assistant。
  //   用 service_role 读是因为 messages 虽对用户可读，归属判定我们自己做更清楚。
  const { data: msg, error } = await db.from('messages')
    .select('id,session_id,user_id,role,content,partial,request_id,created_at')
    .eq('id', messageId).maybeSingle();
  if (error) {
    console.warn('[chat-resume] read failed', user.id.slice(0, 8), safe(error.message));
    return json(500, { error: 'LEDGER_UNAVAILABLE' });
  }
  if (!msg || msg.user_id !== user.id || msg.role !== 'assistant') {
    // 不区分"不存在"与"不是你的"：后者是探测他人 id 的探针
    return json(404, { error: 'MESSAGE_NOT_FOUND' });
  }

  let row = msg as Row;
  if (row.partial) {
    const settled = await hasLedgerPair(db, row.request_id);
    if (!settled) row = (await waitForCompletion(db, row) ?? row);
  }

  return sse(row);
});

interface Row {
  id: string;
  session_id: string;
  content: string;
  partial: boolean;
  request_id: string | null;
}

/**
 * 账本里是否已给过这条 request 一个结论（settle 或 refund）。
 * 有 ⇒ chat 那次请求已经结过账，续接只做交付，不再碰钱；
 * 没有 ⇒ 生成侧可能还在跑，或者已经被硬超时打断留下在途冻结。
 */
async function hasLedgerPair(db: any, requestId: string | null) {
  if (!requestId) return true;   // 没有 request_id 的历史消息：不去猜账，直接交付
  const { data } = await db.from('ledger')
    .select('id').eq('request_id', requestId).in('type', ['settle', 'refund']).limit(1);
  return (data?.length ?? 0) > 0;
}

/**
 * 轮询等到"内容变完整"或"账本给了结论"为止。
 * 刻意只在服务端读同一行，不订阅 Realtime —— 这是一次性补投，
 * 建长连接的代价比多查几次大得多。
 */
async function waitForCompletion(db: any, row: Row): Promise<Row | null> {
  const deadline = Date.now() + WAIT_MS;
  let current: Row = row;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const { data } = await db.from('messages')
      .select('id,session_id,content,partial,request_id')
      .eq('id', row.id).maybeSingle();
    if (!data) continue;
    current = data as Row;
    if (!current.partial) return current;
    if (await hasLedgerPair(db, current.request_id)) return current;
  }
  return current;
}

// ─── SSE：帧格式与 chat/index.ts 逐字对齐 ────────────────
function sse(row: Row): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

      send('meta', {
        message_id: row.id,
        user_message_id: null,
        model: 'resume',
        provider: 'resume',
        frozen: 0,
        carried_tokens: 0,
        byok: false,
        replay: true,
      });

      if (row.content) send('delta', { t: row.content });

      if (row.partial) {
        // 仍是半句：告诉客户端"这部分是真的，后面没了"，由它决定要不要出续写入口
        send('error', { code: 'MODEL_STREAM_BREAK', msg: '说到一半断了，这里是已经说出来的部分。', partial: true });
      } else {
        send('done', { replay: true });
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'access-control-allow-origin': '*',
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}
