/**
 * useChat.ts — 一轮对话的状态机
 *
 * 规矩（docs/分册-网页端.md §7.3、§9）：
 *   · 用户消息乐观上屏，服务端确认后落地；失败标红可重试
 *   · AI 消息在流结束前是"临时气泡"，done 之后以服务端版本为准
 *   · 断流保留已显示内容 + 出「继续」，不重新生成（重新生成会重复扣费）
 *   · 组件卸载不 abort 请求 —— 服务端还在生成并落库
 *   · 组合输入（中文输入法候选）期间禁止发送
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { newRequestId, supabase } from '../../lib/supabase';
import { streamChat, resumeChat, type ChatEvent } from '../../lib/sse';

export interface Draft {
  id: string;                 // 本地 id，乐观渲染用
  requestId?: string;
  pending?: boolean;
  failed?: boolean;
  text: string;
}

export interface ChatState {
  drafts: Draft[];
  streaming: boolean;
  streamText: string;
  canResume: boolean;
  error: string | null;
  cost: { settled: number; balance: number | null; cacheHit: boolean } | null;
  send: (text: string) => Promise<void>;
  retry: (draftId: string) => Promise<void>;
  resume: () => Promise<void>;
  reset: () => void;
  composing: boolean;
  setComposing: (v: boolean) => void;
}

export function useChat(sessionId: string, provider?: { kind: 'openai' | 'anthropic'; profile_id: string } | null): ChatState {
  const qc = useQueryClient();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [resumable, setResumable] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cost, setCost] = useState<ChatState['cost']>(null);
  const [composing, setComposing] = useState(false);

  // 流结束后再读，避免闭包里拿到旧的 sessionId
  const activeRef = useRef(sessionId);
  activeRef.current = sessionId;

  // 换会话时必须清干净，否则上一个会话的流式尾巴会串进来
  useEffect(() => {
    setDrafts([]); setStreamText(''); setStreaming(false);
    setResumable(null); setError(null); setCost(null);
  }, [sessionId]);

  const handle = useCallback((e: ChatEvent, requestId: string) => {
    switch (e.type) {
      case 'meta':
        setStreaming(true);
        break;

      case 'delta':
        setStreamText((prev) => prev + e.text);
        break;

      case 'done': {
        setStreaming(false);
        setStreamText('');
        setCost({
          settled: Number(e.data.settled ?? 0),
          balance: e.data.balance ?? null,
          cacheHit: Boolean(e.data.cache_hit),
        });
        setDrafts((d) => d.filter((x) => x.requestId !== requestId || !x.pending));
        // 服务端才是真源：拉一次，把 AI 消息按落库版本显示出来
        void qc.invalidateQueries({ queryKey: ['messages', activeRef.current] });
        window.dispatchEvent(new CustomEvent('echosoul:first-reply'));
        break;
      }

      case 'error': {
        setStreaming(false);
        setError(e.data.msg);
        // 已有部分内容 ⇒ 保留显示并给续接入口，别让它凭空消失
        setStreamText((t) => {
          if (t && e.data.partial) {
            setResumable((r) => r ?? 'pending');
            setDrafts((d) => [
              ...d.filter((x) => x.requestId !== requestId),
              { id: `broken-${requestId}`, text: t, pending: false },
            ]);
            return '';
          }
          return t;
        });
        setDrafts((d) => d.map((x) =>
          x.requestId === requestId ? { ...x, pending: false } : x));
        void qc.invalidateQueries({ queryKey: ['messages', activeRef.current] });
        void qc.invalidateQueries({ queryKey: ['balance'] });
        break;
      }
    }
  }, [qc]);

  const run = useCallback(async (text: string, requestId: string, draftId: string) => {
    setError(null);
    setStreamText('');
    setResumable(null);
    setDrafts((d) => d.map((x) => x.id === draftId ? { ...x, pending: true, failed: false } : x));
    try {
      await streamChat({ sessionId: activeRef.current, content: text, requestId, provider: provider ?? null,
        onEvent: (e) => handle(e, requestId) });
    } catch {
      setDrafts((d) => d.map((x) => x.id === draftId ? { ...x, pending: false, failed: true } : x));
      setError('没发出去，检查一下网络。');
    }
  }, [handle, provider]);

  const send = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t || streaming || composing) return;
    const requestId = newRequestId();
    const draftId = `u-${requestId}`;
    setDrafts((d) => [...d, { id: draftId, requestId, text: t, pending: true }]);
    await run(t, requestId, draftId);
  }, [streaming, composing, run]);

  const retry = useCallback(async (draftId: string) => {
    const d = drafts.find((x) => x.id === draftId);
    if (!d) return;
    const requestId = d.requestId ?? newRequestId();
    // 复用同一个幂等键：服务端不会因此重复扣费
    await run(d.text, requestId, draftId);
  }, [drafts, run]);

  const resume = useCallback(async () => {
    if (!resumable) return;
    setError(null);
    setResumable(null);
    setStreamText('');
    setStreaming(true);
    // 断流时服务端仍在生成并已落库，所以按库里的最后一条 assistant 消息续接
    const last = await fetchLastAssistantMessageId(activeRef.current);
    if (!last) { setError('找不到要续接的那条消息了。'); setStreaming(false); return; }
    await resumeChat(last, (e) => handle(e, `resume-${last}`));
  }, [resumable, handle]);

  const reset = useCallback(() => {
    setDrafts([]); setStreamText(''); setError(null); setResumable(null); setStreaming(false);
  }, []);

  return {
    drafts, streaming, streamText, canResume: resumable !== null, error, cost,
    send, retry, resume, reset, composing, setComposing,
  };
}

/** 取该会话最后一条 assistant 消息 id（用于断流续接） */
async function fetchLastAssistantMessageId(sessionId: string): Promise<string | null> {
  // 用静态导入：这个模块在本文件里本来就被静态引用，动态 import 不会真的分包，
  // 只会让构建器报"both static and dynamic"并误导后来人以为这里做了懒加载。
  const { data } = await supabase.from('messages')
    .select('id').eq('session_id', sessionId).eq('role', 'assistant')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  return (data?.id as string | undefined) ?? null;
}
