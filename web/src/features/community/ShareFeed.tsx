/**
 * ShareFeed.tsx — 分享流（用户发的分享图 + 对话片段）
 *
 * 增长 §5.1：这是转化链路的主入口 —— "点开链接能看到这段对话的开头，
 * 但要聊下去得自己来"。所以这一页有两个动作：看图、开聊同一个角色。
 *
 * ★ 三条不可退让：
 *   1. **每条必备举报入口**（§5.4）。
 *   2. **"内容由 AI 生成"标识必须显示**（29 号专篇）。图上已经画进像素了，
 *      这里再叠一层是因为图片可能被裁剪；两层比"赌那张图没被裁"可靠。
 *   3. 进广场默认需审核 —— visibility 为 public 且过了审核的行 RLS 才会放出来，
 *      所以本页不做任何"是不是违规"的前端判断，只渲染服务端给的结果。
 */
import { useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { supabase } from '../../lib/supabase';
import { keys, openSession, resolveShare, toMessage } from '../rpc';
import { ReportSheet } from './report';
import { Avatar } from '../../ui/Avatar';
import { Empty } from '../../ui/Empty';
import { SkeletonRows } from '../../ui/Skeleton';
import { toast } from '../../ui/Toast';
import { IconFlag, IconMessage, IconShare } from '../../ui/icons';

interface ShareRow {
  id: string;
  character_id: string | null;
  session_id: string | null;
  messages: string[];
  image_path: string | null;
  visibility: 'unlisted' | 'public';
  views: number;
  signups: number;
  created_at: string;
  character?: { name: string; avatar_path: string | null } | null;
}

const PAGE = 18;

export function ShareFeed() {
  const navigate = useNavigate();
  const scroller = useRef<HTMLDivElement>(null);
  const [reportFor, setReportFor] = useState<ShareRow | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const feed = useInfiniteQuery({
    queryKey: keys.shareFeed,
    initialPageParam: 0,
    queryFn: async ({ pageParam }): Promise<{ rows: ShareRow[] }> => {
      const { data, error } = await supabase.from('share_links')
        .select('id,character_id,session_id,messages,image_path,visibility,views,signups,created_at, characters(name,avatar_path)')
        // 未过期的公开分享；RLS 已经过滤掉 unlisted 与别人的行
        .eq('visibility', 'public')
        .or('expires_at.is.null,expires_at.gt.now')
        .order('created_at', { ascending: false })
        .range(pageParam, pageParam + PAGE - 1);
      if (error) throw new Error(toMessage(error.code, error.message));
      return {
        rows: ((data ?? []) as unknown as (Omit<ShareRow, 'character'> & {
          characters?: { name: string; avatar_path: string | null } | null;
        })[]).map((r) => ({ ...r, character: r.characters ?? null })),
      };
    },
    getNextPageParam: (last, pages) =>
      last.rows.length === PAGE ? pages.reduce((n, p) => n + p.rows.length, 0) : undefined,
  });

  const rows = useMemo(() => feed.data?.pages.flatMap((p) => p.rows) ?? [], [feed.data]);

  // 两列瀑布：图片高度不一，用虚拟列表按行打包成对
  const pairCount = Math.ceil(rows.length / 2);
  const virt = useVirtualizer({
    count: pairCount,
    getScrollElement: () => scroller.current,
    estimateSize: () => 420,
    overscan: 3,
  });

  const chatWith = useMutation({
    mutationFn: (characterId: string) => openSession(characterId),
    onSuccess: (sid) => void navigate({ to: '/chat/$sessionId', params: { sessionId: sid } }),
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="share-feed">
      <header className="panel-head">
        <h2>别人和 TA 的故事</h2>
        <p className="muted panel-sub">这些是用户自己挑出来公开的片段。点开能看见那几句，想继续聊得自己来。</p>
      </header>

      {feed.isLoading ? <SkeletonRows count={3} h={260} gap={10} /> : null}
      {feed.isError ? (
        <p className="cd-notice cd-notice-bad">这条流没打开。<button type="button" className="btn" onClick={() => void feed.refetch()}>再试</button></p>
      ) : null}

      {!feed.isLoading && rows.length === 0 ? (
        <Empty
          title="还没有公开的分享"
          hint="分享的图要先过审核才会出现在这儿。你也可以从任意一段聊天里选几句做成图。"
          icon={<IconShare />}
        />
      ) : null}

      {rows.length > 0 ? (
        <div ref={scroller} className="scroll-pane feed-scroll" role="list">
          <div style={{ height: virt.getTotalSize(), position: 'relative', width: '100%' }}>
            {virt.getVirtualItems().map((item) => {
              const a = rows[item.index * 2];
              const b = rows[item.index * 2 + 1];
              if (!a) return null;
              return (
                <div
                  key={a.id}
                  data-index={item.index}
                  ref={virt.measureElement}
                  className="row feed-pair"
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}
                >
                  <ShareTile row={a} expanded={openId === a.id} onExpand={() => setOpenId(openId === a.id ? null : a.id)} onChat={(cid) => chatWith.mutate(cid)} onReport={() => setReportFor(a)} />
                  {b
                    ? <ShareTile row={b} expanded={openId === b.id} onExpand={() => setOpenId(openId === b.id ? null : b.id)} onChat={(cid) => chatWith.mutate(cid)} onReport={() => setReportFor(b)} />
                    : <span className="feed-tile feed-ghost" aria-hidden="true" />}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {reportFor ? (
        <ReportSheet target={{ kind: 'share', id: reportFor.id, label: reportFor.character?.name ?? '这条分享' }} onClose={() => setReportFor(null)} />
      ) : null}
    </div>
  );
}

function ShareTile({ row, expanded, onExpand, onChat, onReport }: {
  row: ShareRow; expanded: boolean;
  onExpand: () => void;
  onChat: (characterId: string) => void;
  onReport: () => void;
}) {
  return (
    <article className="feed-tile">
      {/* ★ AI 生成标识：图上已画进像素，这里再叠一层防止被裁切后丢失 */}
      <button type="button" className="feed-media" onClick={onExpand}>
        {row.image_path
          ? <img src={row.image_path} alt="分享图" loading="lazy" width={540} height={720} />
          : <span className="feed-nomedia muted">这段没有出图，只有文字</span>}
        <span className="feed-ai-tag">内容由 AI 生成</span>
      </button>

      <div className="row feed-head">
        <Avatar src={row.character?.avatar_path ?? null} name={row.character?.name ?? '星回'} size={30} />
        <span className="grow col">
          <b className="feed-name">{row.character?.name ?? '这个角色'}</b>
          <span className="muted feed-stat">{row.views} 次看过 · {row.signups} 人因此进来</span>
        </span>
      </div>

      {expanded ? <ExpandedBody linkId={row.id} /> : null}

      <footer className="row feed-foot">
        {row.character_id ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onChat(row.character_id as string)}>
            <IconMessage size={15} /> <span>找这个 TA 聊</span>
          </button>
        ) : <span className="muted">这个角色已经不在了</span>}
        {/* ★ 每条必备 */}
        <button type="button" className="btn btn-ghost btn-sm comment-report" onClick={onReport}>
          <IconFlag size={14} /> <span>举报</span>
        </button>
      </footer>
    </article>
  );
}

/** 展开时按短码取正文：resolve_share 只回被显式勾选的那几条，且不含 user_id/session_id */
function ExpandedBody({ linkId }: { linkId: string }) {
  const q = useQuery({
    queryKey: ['resolved-share', linkId],
    queryFn: () => resolveShare(linkId),
    staleTime: 60_000,
  });

  if (q.isLoading) return <SkeletonRows count={2} h={44} gap={6} />;
  if (q.isError || !q.data?.ok) return <p className="muted">这段内容取不到了，可能已经过期。</p>;

  return (
    <ul className="feed-body">
      {(q.data.messages ?? []).map((m, i) => (
        <li key={i} className={`feed-line ${m.role === 'user' ? 'feed-user' : 'feed-role'}`}>
          <span className="feed-who muted">{m.role === 'user' ? '某人' : (q.data.character?.name ?? 'TA')}</span>
          {/* 服务端已截到 600 字；文本走 children，不解析 HTML */}
          <span className="feed-text">{m.content}</span>
        </li>
      ))}
    </ul>
  );
}
