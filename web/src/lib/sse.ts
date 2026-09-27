/**
 * sse.ts — 流式对话客户端
 *
 * 四条不能省的规矩（docs/分册-网页端.md §7.3、docs/分册-模型与计费.md §9）：
 *   1. 半帧必须缓冲 —— 一个 SSE 帧可能被 TCP 拆成两次到达
 *   2. delta 不能逐条 setState —— 用 rAF 合并，否则长回复会掉帧
 *   3. 断线要能续 —— 带 message_id 续接，不重新生成（重新生成会重复扣费）
 *   4. 组件卸载**不得** abort 请求 —— 服务端还在生成并落库，中断显示不等于中断生成
 */
import { fnUrl, accessToken } from './supabase';

export interface ChatMeta {
  message_id: string;
  user_message_id?: string | null;
  model: string;
  provider: string;
  frozen: number;
  carried_tokens: number;
  byok: boolean;
  replay?: boolean;
}

export interface ChatDone {
  usage?: { promptTokens: number; completionTokens: number; cachedTokens: number };
  settled?: number;
  refunded?: number;
  balance?: number | null;
  cache_hit?: boolean;
  replay?: boolean;
}

export interface ChatError {
  code: string;
  msg: string;
  partial?: boolean;
}

export type ChatEvent =
  | { type: 'meta'; data: ChatMeta }
  | { type: 'delta'; text: string }
  | { type: 'done'; data: ChatDone }
  | { type: 'error'; data: ChatError };

export interface ChatParams {
  sessionId: string;
  content: string;
  requestId: string;
  provider?: { kind: 'openai' | 'anthropic'; profile_id: string } | null;
  onEvent: (e: ChatEvent) => void;
  signal?: AbortSignal;
}

/**
 * 发起一轮对话。
 * 返回的 promise 在流结束时 resolve；**不抛业务错误**，错误以 error 事件回吐，
 * 因为断流时可能已有部分内容需要保留显示。
 */
export async function streamChat(p: ChatParams): Promise<void> {
  const token = await accessToken();

  let res: Response;
  try {
    res = await fetch(fnUrl('chat'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        accept: 'text/event-stream',
      },
      // 幂等键：网络重试复用同一个，服务端不会重复扣费
      body: JSON.stringify({
        session_id: p.sessionId,
        content: p.content,
        idempotency_key: p.requestId,
        client: detectClient(),
        ...(p.provider ? { provider: p.provider } : {}),
      }),
      // exactOptionalPropertyTypes：不能把 undefined 赋给 signal，只能整个键不传
      ...(p.signal ? { signal: p.signal } : {}),
    });
  } catch (e) {
    p.onEvent({ type: 'error', data: { code: 'NETWORK', msg: '网络不通，检查一下连接再试。' } });
    return;
  }

  if (!res.ok || !res.body) {
    const code = await readErrorCode(res);
    p.onEvent({ type: 'error', data: { code, msg: messageFor(code) } });
    return;
  }

  await consume(res.body, p.onEvent);
}

/** 断线续接：让服务端把已生成的部分补完，不重新发起生成 */
export async function resumeChat(messageId: string, onEvent: (e: ChatEvent) => void): Promise<void> {
  const token = await accessToken();
  const res = await fetch(fnUrl('chat-resume'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ message_id: messageId }),
  });
  if (!res.ok || !res.body) {
    onEvent({ type: 'error', data: { code: 'RESUME_FAILED', msg: '续接没成功，重新发一条试试。' } });
    return;
  }
  await consume(res.body, onEvent);
}

// ─── 帧解析 ────────────────────────────────────────────
async function consume(body: ReadableStream<Uint8Array>, onEvent: (e: ChatEvent) => void) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';

  // delta 合并到 rAF 再回调：长回复时逐 token setState 会掉帧
  let pending = '';
  let raf = 0;
  const flush = () => {
    raf = 0;
    if (!pending) return;
    const t = pending;
    pending = '';
    onEvent({ type: 'delta', text: t });
  };
  const queue = (t: string) => {
    pending += t;
    if (!raf) raf = requestAnimationFrame(flush);
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });

      // 一帧以空行结束；没收到空行的部分留在 buf 里等下一块
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = parseFrame(frame);
        if (!ev) continue;
        if (ev.type === 'delta') queue(ev.text);
        else {
          // 非 delta 事件前先把缓冲的字吐出去，保证顺序
          if (raf) { cancelAnimationFrame(raf); raf = 0; }
          flush();
          onEvent(ev);
          if (ev.type === 'done' || ev.type === 'error') return;
        }
      }
    }
  } catch (e) {
    // 流被切断：已显示的内容保留，交给上层出「继续」按钮
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    flush();
    onEvent({ type: 'error', data: { code: 'MODEL_STREAM_BREAK', msg: '说到一半断了。', partial: true } });
    return;
  }

  if (raf) { cancelAnimationFrame(raf); flush(); }
  else flush();
}

function parseFrame(frame: string): ChatEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    // id:/retry: 目前不需要
  }
  if (!dataLines.length) return null;
  let data: unknown;
  try { data = JSON.parse(dataLines.join('\n')); } catch { return null; }

  switch (event) {
    case 'meta': return { type: 'meta', data: data as ChatMeta };
    case 'delta': return { type: 'delta', text: (data as { t?: string }).t ?? '' };
    case 'done': return { type: 'done', data: data as ChatDone };
    case 'error': return { type: 'error', data: data as ChatError };
    default: return null;
  }
}

async function readErrorCode(res: Response): Promise<string> {
  try {
    const j = await res.json();
    if (typeof j?.error === 'string') return j.error;
    if (typeof j?.code === 'string') return j.code;
  } catch { /* 非 JSON 错误体 */ }
  if (res.status === 401) return 'UNAUTHORIZED';
  if (res.status === 402) return 'INSUFFICIENT_BALANCE';
  if (res.status === 429) return 'RATE_LIMITED';
  return 'UPSTREAM_5XX';
}

function messageFor(code: string): string {
  switch (code) {
    case 'INSUFFICIENT_BALANCE': return '额度用完了，续一下就能继续聊。';
    case 'UNAUTHORIZED': return '登录状态过期了，重新登录一下。';
    case 'RATE_LIMITED': return '这会儿有点挤，稍等一下再发。';
    case 'SESSION_NOT_FOUND': return '这个会话找不到了，刷新看看。';
    default: return '刚才没成功，再试一次。';
  }
}

function detectClient(): 'web' | 'android' | 'ios-webapp' {
  const ua = navigator.userAgent;
  if (/Android/.test(ua) && (navigator as unknown as { isNativeShell?: boolean }).isNativeShell) {
    return 'android';
  }
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches
    || (navigator as unknown as { standalone?: boolean }).standalone === true;
  if (/iPad|iPhone|iPod/.test(ua) && standalone) return 'ios-webapp';
  return 'web';
}
