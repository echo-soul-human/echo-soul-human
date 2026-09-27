/**
 * Comments.tsx — 角色详情页下的评论区（增长 §5.1）
 *
 * 一期明确不做：论坛式发帖/版块/等级、用户之间私信、排行榜与投票（§5.2）。
 * 所以这里就是一个扁平列表 + 一层回复，没有嵌套楼中楼。
 *
 * ★ 发布前必须明示将被公开的具体内容 —— 评论本身就是公开内容，
 *   所以发送键旁边固定显示"这条会出现在广场上，任何人都能看到"，
 *   并且昵称按设置里的匿名偏好显示（不强制真名）。
 *
 * ⚠ comments 表尚未建。加载失败要说明是通道没开，而不是"还没有人说话"——
 *   后者会让人以为社区死了。
 */
import { useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { supabase } from '../../lib/supabase';
import { keys, toMessage, currentUserId } from '../rpc';
import { ReportSheet } from './report';
import { Avatar } from '../../ui/Avatar';
import { Empty } from '../../ui/Empty';
import { SkeletonRows } from '../../ui/Skeleton';
import { toast } from '../../ui/Toast';
import { IconFlag, IconMessage } from '../../ui/icons';

interface CommentRow {
  id: string;
  body: string;
  author_handle: string | null;
  author_avatar: string | null;
  parent_id: string | null;
  created_at: string;
  user_id: string;
}

const PAGE = 30;
const MAX_LEN = 800;

export function Comments({ characterId, characterName }: { characterId: string; characterName: string }) {
  const qc = useQueryClient();
  const scroller = useRef<HTMLDivElement>(null);
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<CommentRow | null>(null);
  const [reportFor, setReportFor] = useState<CommentRow | null>(null);

  const me = useQuery({ queryKey: ['me'], queryFn: currentUserId, staleTime: 3_600_000 });

  const feed = useInfiniteQuery({
    queryKey: keys.comments(characterId),
    initialPageParam: 0,
    queryFn: async ({ pageParam }): Promise<{ rows: CommentRow[] }> => {
      const { data, error } = await supabase.from('comments')
        .select('id,body,parent_id,created_at,user_id, profiles!comments_user_id_fkey(handle,avatar_path)')
        .eq('character_id', characterId)
        .order('created_at', { ascending: false })
        .range(pageParam, pageParam + PAGE - 1);
      if (error) throw new Error(toMessage(error.code, error.message));
      return {
        rows: ((data ?? []) as unknown as (Omit<CommentRow, 'author_handle' | 'author_avatar'> & {
          profiles?: { handle: string | null; avatar_path: string | null };
        })[]).map((r) => ({
          ...r,
          author_handle: r.profiles?.handle ?? null,
          author_avatar: r.profiles?.avatar_path ?? null,
        })),
      };
    },
    getNextPageParam: (last, pages) =>
      last.rows.length === PAGE ? pages.reduce((n, p) => n + p.rows.length, 0) : undefined,
  });

  /** 顶层评论按时间正序排，回复挂在父层下面 —— 读起来才像对话而不是倒着刷 */
  const tree = useMemo(() => {
    const all = feed.data?.pages.flatMap((p) => p.rows) ?? [];
    const roots = all.filter((c) => !c.parent_id).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const kids = new Map<string, CommentRow[]>();
    for (const c of all.filter((x) => x.parent_id)) {
      const arr = kids.get(c.parent_id as string) ?? [];
      arr.push(c);
      kids.set(c.parent_id as string, arr);
    }
    for (const list of kids.values()) list.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return roots.map((r) => ({ root: r, replies: kids.get(r.id) ?? [] }));
  }, [feed.data]);

  const flat = useMemo(() => tree.flatMap((t) => [t.root, ...t.replies]), [tree]);

  // 评论数量不大（一期冷启动 10-20 条示例），但仍然虚拟化：
  // 长评一多，DOM 数量就不是"暂时够用"能解释的了
  const virt = useVirtualizer({
    count: flat.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 96,
    overscan: 6,
  });

  const post = useMutation({
    mutationFn: async () => {
      const uid = me.data;
      if (!uid) throw new Error('UNAUTHORIZED');
      const text = (replyTo ? body : body).trim();
      if (!text) throw new Error('EMPTY');
      const { error } = await supabase.from('comments').insert({
        user_id: uid,
        character_id: characterId,
        body: text.slice(0, MAX_LEN),
        ...(replyTo ? { parent_id: replyTo.id } : {}),
      });
      if (error) throw new Error(toMessage(error.code, error.message));
    },
    onSuccess: () => {
      setBody('');
      setReplyTo(null);
      void qc.invalidateQueries({ queryKey: keys.comments(characterId) });
      toast.ok('发出去了，这条已经公开');
    },
    onError: (e: Error) => toast.error(/relation|does not exist/i.test(e.message)
      ? '评论通道还在建设中，这次没能发出去。'
      : e.message),
  });

  const canPost = body.trim().length >= 2 && !post.isPending;

  return (
    <div className="comments">
      <header className="panel-head">
        <h3>{characterName} 的讨论</h3>
        <p className="muted panel-sub">玩法提示、名场面、求设定。不谈感情问题以外的隐私。</p>
      </header>

      {/* ── 输入区：公开性提示紧贴发送键 ─────────── */}
      <div className="comment-compose">
        {replyTo ? (
          <div className="row reply-to">
            <span className="grow muted">回 {displayName(replyTo)}：{clip(replyTo.body, 30)}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setReplyTo(null)}>不回了</button>
          </div>
        ) : null}

        <textarea
          className="comment-input"
          value={body} rows={3} maxLength={MAX_LEN}
          aria-label={replyTo ? '写一条回复' : '写一条讨论'}
          placeholder={replyTo ? '想补充什么？' : `关于 ${characterName}，说点什么`}
          onChange={(e) => setBody(e.target.value)}
        />

        <div className="row compose-foot">
          <span className="muted grow compose-public">
            这条会出现在<b>广场</b>上，任何登录的人都能看到；你的昵称也会一起显示。
            不想带名字的话去设置里改成匿名。
          </span>
          <span className="muted compose-count">{body.length}/{MAX_LEN}</span>
          <button type="button" className="btn btn-primary" disabled={!canPost} onClick={() => post.mutate()}>
            {post.isPending ? '发送中…' : replyTo ? '回复' : '公开说出'}
          </button>
        </div>
      </div>

      {feed.isLoading ? <SkeletonRows count={3} h={96} gap={8} /> : null}

      {!feed.isLoading && feed.isError ? (
        <p className="cd-notice">
          评论还取不到（这块服务端还没开）。这不是没人说话，再等等或稍后刷新。
          <button type="button" className="btn btn-ghost" onClick={() => void feed.refetch()}>刷新</button>
        </p>
      ) : null}

      {!feed.isLoading && !feed.isError && flat.length === 0 ? (
        <Empty
          title="还没有人在这儿说话"
          hint="第一个说的可以只是「我是被哪句话留住的」。"
          icon={<IconMessage />}
        />
      ) : null}

      {flat.length > 0 ? (
        <div ref={scroller} className="scroll-pane comment-scroll" role="list">
          <div style={{ height: virt.getTotalSize(), position: 'relative', width: '100%' }}>
            {virt.getVirtualItems().map((item) => {
              const c = flat[item.index];
              if (!c) return null;
              const isRoot = !c.parent_id;
              return (
                <div
                  key={c.id}
                  data-index={item.index}
                  ref={virt.measureElement}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}
                >
                  <CommentNode
                    row={c}
                    mine={c.user_id === me.data}
                    indent={!isRoot}
                    onReply={() => setReplyTo(c)}
                    onReport={() => setReportFor(c)}
                  />
                </div>
              );
            })}
          </div>
          {feed.hasNextPage ? (
            <button type="button" className="btn btn-ghost flow-more" disabled={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>
              {feed.isFetchingNextPage ? '加载中…' : '看更多'}
            </button>
          ) : null}
        </div>
      ) : null}

      {reportFor ? (
        <ReportSheet target={{ kind: 'comment', id: reportFor.id, label: clip(reportFor.body, 20) }} onClose={() => setReportFor(null)} />
      ) : null}
    </div>
  );
}

function CommentNode({ row, mine, indent, onReply, onReport }: {
  row: CommentRow; mine: boolean; indent: boolean; onReply: () => void; onReport: () => void;
}) {
  return (
    <article className={`comment${indent ? ' comment-reply' : ''}`}>
      <Avatar src={row.author_avatar} name={displayName(row)} size={indent ? 26 : 34} />
      <div className="grow col">
        <div className="row comment-top">
          <b className="comment-who">{displayName(row)}</b>
          {mine ? <span className="comment-mine">你</span> : null}
          <span className="muted comment-time">{relDate(row.created_at)}</span>
        </div>
        <p className="comment-body">{row.body}</p>
        <div className="row comment-ops">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onReply}>回复</button>
          {/* ★ 每条必备举报入口 */}
          <button type="button" className="btn btn-ghost btn-sm comment-report" onClick={onReport}>
            <IconFlag size={14} /> <span>举报</span>
          </button>
        </div>
      </div>
    </article>
  );
}

/** 没设昵称的用户统一显示为"星友 + 尾号"，绝不暴露 uuid 全串 */
function displayName(c: CommentRow): string {
  return c.author_handle || `星友${c.user_id.slice(0, 4)}`;
}

function clip(s: string, n: number): string { return s.length > n ? `${s.slice(0, n)}…` : s; }

function relDate(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前`;
  if (d.toDateString() === new Date().toDateString()) return `今天 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
