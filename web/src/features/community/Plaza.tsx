/**
 * Plaza.tsx — 广场（角色卡公开列表）
 *
 * 一期定位（增长 §5.1）：官方 + 审核通过的公开卡，标签筛选，一键开聊。
 * 明确不做：算法推荐、排行榜、私信（§5.2）。首屏留"编辑精选"人工运营位 ——
 * 一期没有数据量，硬上排序算法只会把新卡永远压在下面。
 *
 * ★ 举报入口每条必备（§5.4）。这里做成卡片上的一个显性按钮而不是藏在菜单里：
 *   藏起来等于没有，而"能不能被举报"决定了这套治理条款是不是真的。
 *
 * RLS 已经把未通过审核的卡过滤掉了（004 p_characters_read），所以前端不再二次筛选。
 */
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { keys, openSession, toMessage } from '../rpc';
import { ReportSheet } from './report';
import { Avatar } from '../../ui/Avatar';
import { Empty } from '../../ui/Empty';
import { Sheet } from '../../ui/Sheet';
import { SkeletonRows } from '../../ui/Skeleton';
import { toast } from '../../ui/Toast';
import { IconChevronDown, IconFlag, IconMessage, IconSearch, IconUsers } from '../../ui/icons';

export interface PlazaCard {
  id: string;
  name: string;
  tagline: string;
  avatar_path: string | null;
  tags: string[];
  owner_id: string | null;
  greeting: string;
  created_at: string;
}

const PAGE = 24;

export function Plaza() {
  const navigate = useNavigate();
  const [tag, setTag] = useState('');
  const [q, setQ] = useState('');
  const [reportFor, setReportFor] = useState<PlazaCard | null>(null);
  const [detailFor, setDetailFor] = useState<PlazaCard | null>(null);

  const feed = useInfiniteQuery({
    queryKey: keys.plaza(tag),
    initialPageParam: 0,
    queryFn: async ({ pageParam }): Promise<{ rows: PlazaCard[]; from: number }> => {
      let builder = supabase.from('characters')
        .select('id,name,tagline,avatar_path,tags,owner_id,greeting,created_at')
        .eq('visibility', 'public')
        .order('created_at', { ascending: false })
        .range(pageParam, pageParam + PAGE - 1);
      if (tag) builder = builder.contains('tags', [tag]);
      const { data, error } = await builder;
      if (error) throw new Error(toMessage(error.code, error.message));
      return { rows: (data ?? []) as PlazaCard[], from: pageParam };
    },
    getNextPageParam: (last, pages) =>
      last.rows.length === PAGE ? pages.reduce((n, p) => n + p.rows.length, 0) : undefined,
  });

  const all = useMemo(() => feed.data?.pages.flatMap((p) => p.rows) ?? [], [feed.data]);

  // 关键词只在已加载的页里筛：32 篇协议那页同理 —— 服务端全文检索不在一期预算内
  const list = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return all;
    return all.filter((c) => `${c.name}${c.tagline}${c.tags.join('')}`.toLowerCase().includes(kw));
  }, [all, q]);

  const tagCloud = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of all) for (const t of c.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  }, [all]);

  const chat = useMutation({
    mutationFn: (id: string) => openSession(id),
    onSuccess: (sid) => void navigate({ to: '/chat/$sessionId', params: { sessionId: sid } }),
    onError: (e: Error) => toast.error(e.message),
  });

  const loadMore = useCallback(() => void feed.fetchNextPage(), [feed]);

  return (
    <div className="plaza">
      <header className="panel-head plaza-head">
        <h2>广场</h2>
        <p className="muted panel-sub">别人造好并且通过审核的角色。点开就能聊。</p>
      </header>

      <div className="field plaza-search">
        <label htmlFor="pz-q" className="sr-only">搜索角色</label>
        <span className="search-box">
          <IconSearch size={17} />
          <input
            id="pz-q" value={q} maxLength={30} placeholder="找名字或设定里的词"
            onChange={(e) => setQ(e.target.value)}
          />
        </span>
      </div>

      {tagCloud.length > 0 ? (
        <div className="row plaza-tags" role="group" aria-label="按标签筛选">
          <button type="button" className={`chip${tag === '' ? ' chip-on' : ''}`} onClick={() => setTag('')}>全部</button>
          {tagCloud.map(([t, n]) => (
            <button
              key={t} type="button" className={`chip${tag === t ? ' chip-on' : ''}`}
              aria-pressed={tag === t}
              onClick={() => setTag(tag === t ? '' : t)}
            >
              {t}<span className="chip-note">{n}</span>
            </button>
          ))}
        </div>
      ) : null}

      {feed.isLoading ? <SkeletonRows count={4} h={92} gap={8} /> : null}
      {feed.isError ? (
        <p className="cd-notice cd-notice-bad">广场没打开。<button type="button" className="btn" onClick={() => void feed.refetch()}>再试</button></p>
      ) : null}

      {!feed.isLoading && list.length === 0 ? (
        <Empty
          title={q || tag ? '这里还没有对得上的角色' : '广场还是空的'}
          hint={q || tag
            ? '换个词或去掉标签试试。搜的范围是已经加载出来的这些卡。'
            : '第一批卡要等审核通过才会出现。你也可以自己造一个 —— 首页「造一个」三分钟就能聊上。'}
          icon={<IconUsers />}
          alt={tag || q ? <button type="button" className="btn btn-ghost" onClick={() => { setTag(''); setQ(''); }}>清掉筛选</button> : undefined}
        />
      ) : null}

      <ul className="plaza-grid">
        {list.map((c) => (
          <li key={c.id}>
            <article className="plaza-card">
              <button type="button" className="row plaza-main" onClick={() => setDetailFor(c)}>
                <Avatar src={c.avatar_path} name={c.name} size={46} />
                <span className="col grow plaza-text">
                  <span className="row">
                    <b className="plaza-name">{c.name}</b>
                    {c.owner_id === null ? <span className="char-badge">官方</span> : null}
                  </span>
                  <span className="muted plaza-tag">{c.tagline || '没写介绍'}</span>
                </span>
              </button>

              {c.tags.length ? (
                <div className="row plaza-cardtags">
                  {c.tags.slice(0, 3).map((t) => <span key={t} className="chip chip-sm">{t}</span>)}
                </div>
              ) : null}

              {/* ★ 举报入口每条必备 */}
              <footer className="row plaza-foot">
                <button
                  type="button" className="btn btn-primary btn-sm"
                  disabled={chat.isPending}
                  onClick={() => chat.mutate(c.id)}
                >
                  <IconMessage size={15} /> <span>聊聊 TA</span>
                </button>
                <button
                  type="button" className="btn btn-ghost btn-sm plaza-report"
                  onClick={() => setReportFor(c)}
                >
                  <IconFlag size={15} /> <span>举报</span>
                </button>
              </footer>
            </article>
          </li>
        ))}
      </ul>

      {feed.hasNextPage ? (
        <button type="button" className="btn plaza-more" disabled={feed.isFetchingNextPage} onClick={loadMore}>
          <IconChevronDown size={16} /> <span>{feed.isFetchingNextPage ? '加载中…' : '再看一些'}</span>
        </button>
      ) : list.length > 0 ? (
        <p className="muted plaza-end">到这里就是全部了。</p>
      ) : null}

      {reportFor ? (
        <ReportSheet
          target={{ kind: 'character', id: reportFor.id, label: reportFor.name }}
          onClose={() => setReportFor(null)}
        />
      ) : null}

      {detailFor ? (
        <Sheet title={detailFor.name} onClose={() => setDetailFor(null)} wide>
          <CardDetail characterId={detailFor.id} onChat={(sid) => { setDetailFor(null); void navigate({ to: '/chat/$sessionId', params: { sessionId: sid } }); }} />
        </Sheet>
      ) : null}
    </div>
  );
}

// ── 卡片详情（广场侧只读；自己的卡走 CharacterDetail）──
export function CardDetail({ characterId, onChat }: { characterId: string; onChat: (sessionId: string) => void }) {
  const q = useQuery({
    queryKey: ['plaza-card', characterId],
    queryFn: async () => {
      const { data, error } = await supabase.from('characters')
        .select('id,name,tagline,persona_text,greeting,example_dialogs,avatar_path,portrait_path,tags,voice_profile_id,emotion_portraits')
        .eq('id', characterId).single();
      if (error) throw new Error(toMessage(error.code, error.message));
      return data as {
        id: string; name: string; tagline: string; persona_text: string; greeting: string;
        example_dialogs: unknown; avatar_path: string | null; portrait_path: string | null;
        tags: string[]; voice_profile_id: string | null; emotion_portraits: Record<string, string>;
      };
    },
  });

  if (q.isLoading) return <SkeletonRows count={3} h={72} gap={10} />;
  if (q.isError || !q.data) return <p className="muted">这张卡的细节打不开了。</p>;

  const d = q.data;
  const examples = Array.isArray(d.example_dialogs) ? (d.example_dialogs as { user?: string; role?: string }[]) : [];
  const emotions = Object.keys(d.emotion_portraits ?? {}).filter((k) => d.emotion_portraits[k]);

  return (
    <div className="card-detail">
      <div className="row cd-head">
        <Avatar src={d.avatar_path} name={d.name} size={56} />
        <div className="col grow">
          <b>{d.name}</b>
          <span className="muted">{d.tagline || '没写介绍'}</span>
        </div>
      </div>

      {emotions.length > 0 ? (
        <div className="row cd-emotions">
          {emotions.map((e) => (
            <img key={e} className="cd-emo-img" src={d.emotion_portraits[e]} alt={`${e}时的样子`} width={64} height={64} loading="lazy" />
          ))}
        </div>
      ) : null}

      <section className="cd-block">
        <h4 className="sec-title">TA 是什么样的人</h4>
        <p className="cd-persona">{d.persona_text || '作者没写这段。'}</p>
      </section>

      {examples.length ? (
        <section className="cd-block">
          <h4 className="sec-title">示例对话</h4>
          <ul className="ex-list ex-readonly">
            {examples.slice(0, 6).map((ex, i) => (
              <li key={i} className="ex-pair">
                {ex.user ? <p className="ex-user">你：{ex.user}</p> : null}
                {ex.role ? <p className="ex-role role-text">{d.name}：{ex.role}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="sheet-actions">
        <button type="button" className="btn btn-primary" onClick={() => void openSession(characterId).then(onChat)}>
          <IconMessage size={16} /> <span>开始聊</span>
        </button>
      </div>

      <p className="muted cd-legal">
        人设文本是作者的创作（23 号专篇）。看到疑似抄袭可以在返回的那一页举报。
      </p>
    </div>
  );
}
