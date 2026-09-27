/**
 * ChatView.tsx — 对话主界面
 *
 * 两条最容易做错、做错了会被骂的规矩（docs/分册-网页端.md §7.1）：
 *   1. 聊天列表的锚点是**最后一条**，不是第一条
 *   2. 用户在往上翻历史时新消息到达 ⇒ **绝不抢滚动**，只出"N 条新消息 ↓"
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getRouteApi } from '@tanstack/react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { supabase } from '../../lib/supabase';
import { useChat } from './useChat';
import { Composer } from './Composer';
import { platform } from '../../lib/platform';

const PAGE = 40;
const NEAR_BOTTOM = 120;

const routeApi = getRouteApi('/chat/$sessionId');

interface Row {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
  partial?: boolean;
}

export function ChatView() {
  const { sessionId } = routeApi.useParams();
  const chat = useChat(sessionId);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [unseen, setUnseen] = useState(0);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = useInfiniteQuery({
    queryKey: ['messages', sessionId],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      let q = supabase.from('messages')
        .select('id,role,content,created_at,partial')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false })
        .limit(PAGE);
      if (pageParam) q = q.lt('created_at', pageParam);
      const { data: rows, error } = await q;
      if (error) throw new Error(error.message);
      const list = (rows ?? []) as Row[];
      return { rows: list, nextCursor: list.at(-1)?.created_at };
    },
    getNextPageParam: (last) => (last.rows.length === PAGE ? last.nextCursor : undefined),
  });

  const { data: members } = useQuery({
    queryKey: ['session-members', sessionId],
    queryFn: async () => {
      const { data: d } = await supabase.from('session_members')
        .select('character_id, seat').eq('session_id', sessionId).order('seat');
      const ids = (d ?? []).map((m: { character_id: string }) => m.character_id);
      if (!ids.length) return [];
      const { data: cs } = await supabase.from('characters')
        .select('id,name,avatar_path').in('id', ids);
      return (cs ?? []) as { id: string; name: string; avatar_path: string | null }[];
    },
  });

  const nameOf = useMemo(() => {
    const m = new Map((members ?? []).map((c) => [c.id, c.name]));
    return (id?: string) => (id ? m.get(id) : undefined);
  }, [members]);
  void nameOf;

  // 服务端页是倒序拿的，展示要正序
  const rows = useMemo<Row[]>(() => {
    const pages = data?.pages ?? [];
    const all = [...pages].reverse().flatMap((p) => p.rows).slice().reverse();
    return all;
  }, [data]);

  // 合并乐观草稿：用户消息立即上屏，AI 流式气泡挂在末尾
  const view = useMemo(() => {
    const out: (Row | { id: string; kind: 'draft'; draft: typeof chat.drafts[number] })[] = [];
    for (const r of rows) out.push(r);
    for (const d of chat.drafts) out.push({ id: d.id, kind: 'draft', draft: d });
    return out;
  }, [rows, chat.drafts]);

  const virt = useVirtualizer({
    count: view.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => 76,
    overscan: 8,
    // 锚在末尾：聊天列表不是从 0 开始看的
    initialOffset: () => Number.MAX_SAFE_INTEGER,
  });

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // 首帧与流式更新时跟随；用户上翻后停止跟随
  useEffect(() => {
    if (stickToBottom.current) requestAnimationFrame(() => scrollToBottom());
  }, [view.length, chat.streamText, scrollToBottom]);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
    stickToBottom.current = atBottom;
    if (atBottom) setUnseen(0);
    else if (chat.streaming) setUnseen((n) => n + 0);
    // 接近顶部就翻更早的一页
    if (el.scrollTop < 240 && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [chat.streaming, fetchNextPage, hasNextPage, isFetchingNextPage]);

  // 新消息到达但用户不在底部 ⇒ 不抢滚动，只给提示
  const prevCount = useRef(view.length);
  useEffect(() => {
    if (view.length > prevCount.current && !stickToBottom.current) setUnseen((n) => n + 1);
    prevCount.current = view.length;
  }, [view.length]);

  useEffect(() => {
    if (chat.streaming) window.dispatchEvent(new CustomEvent('echosoul:streaming'));
  }, [chat.streaming]);

  const title = members?.[0]?.name ?? '星回';
  const lowPowered = platform.isLowPowered();

  return (
    <div className={`chat${lowPowered ? ' low-powered' : ''}`}>
      <header className="chat-head">
        <div className="row grow">
          <span className="chat-title">{title}</span>
          <span className="ai-chip" title="回复由 AI 生成">AI</span>
        </div>
        {chat.cost ? (
          <span className="chat-cost muted" aria-live="polite">
            本轮 {chat.cost.settled.toFixed(3)} 元 · 余额 {chat.cost.balance ?? '—'}
          </span>
        ) : null}
      </header>

      <div
        ref={scrollerRef}
        className="scroll-pane message-list"
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
      >
        {isLoading ? <div className="list-loading" aria-busy="true" /> : null}
        {isFetchingNextPage ? <div className="list-more muted">加载中…</div> : null}

        <div style={{ height: virt.getTotalSize(), position: 'relative', width: '100%' }}>
          {virt.getVirtualItems().map((item) => {
            const node = view[item.index];
            if (!node) return null;
            return (
              <div
                key={node.id}
                data-index={item.index}
                ref={virt.measureElement}
                style={{
                  position: 'absolute', top: 0, left: 0, width: '100%',
                  transform: `translateY(${item.start}px)`,
                }}
              >
                {'kind' in node
                  ? <DraftBubble draft={node.draft} onRetry={chat.retry} />
                  : <Bubble row={node} />}
              </div>
            );
          })}
        </div>

        {chat.streaming ? (
          <div className="stream-tail">
            <div className="bubble bubble-role role-text caret selectable">{chat.streamText}</div>
          </div>
        ) : null}
      </div>

      {unseen > 0 ? (
        <button type="button" className="unseen-pill"
          onClick={() => { stickToBottom.current = true; scrollToBottom('smooth'); setUnseen(0); }}>
          {unseen} 条新消息 ↓
        </button>
      ) : null}

      {chat.canResume ? (
        <button type="button" className="resume-pill" onClick={chat.resume}>
          刚才说到一半断了 · 继续
        </button>
      ) : null}

      {chat.error ? <p className="chat-err" role="alert">{chat.error}</p> : null}

      <Composer
        sessionId={sessionId}
        streaming={chat.streaming}
        disabled={false}
        onSend={chat.send}
        onComposingChange={chat.setComposing}
      />
    </div>
  );
}

// ── 气泡 ───────────────────────────────────────────────
function Bubble({ row }: { row: Row }) {
  const mine = row.role === 'user';
  return (
    <div className={`msg ${mine ? 'msg-right' : 'msg-left'}`}>
      <div className={`bubble ${mine ? 'bubble-user user-text' : 'bubble-role role-text'} selectable`}>
        {row.content}
      </div>
      <time className="msg-time muted">{fmtTime(row.created_at)}</time>
    </div>
  );
}

function DraftBubble({ draft, onRetry }: { draft: { id: string; text: string; pending?: boolean; failed?: boolean }; onRetry: (id: string) => void }) {
  return (
    <div className="msg msg-right">
      <div className={`bubble bubble-user user-text selectable${draft.failed ? ' bubble-failed' : ''}`}>
        {draft.text}
        {draft.failed ? (
          <button type="button" className="retry-inline" onClick={() => onRetry(draft.id)}>
            没发出去 · 重发
          </button>
        ) : null}
      </div>
    </div>
  );
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
