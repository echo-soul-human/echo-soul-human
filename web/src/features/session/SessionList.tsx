/**
 * SessionList.tsx — 侧栏会话列表（PC 三栏的左栏 / 移动端抽屉）
 *
 * 数据来源只有 list_sessions RPC：它已经把"最后一条消息、未读数、成员名"
 * 聚合好了，前端**不得**再自己拼一遍 —— 两套算法必然漂移。
 *
 * 三条实现约束：
 *   · §10 长列表必须虚拟化（@tanstack/react-virtual），2000 条不卡。
 *   · §9 服务端状态只走 TanStack Query；置顶/归档用乐观更新只为手感，
 *     失败一定回滚并说明原因。
 *   · 未读红点由 mark_read 清，进会话时调用，不在这里调。
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { keys, listSessions, patchSession, deleteViaRpc, type SessionRow } from '../rpc';
import { Avatar } from '../../ui/Avatar';
import { Sheet } from '../../ui/Sheet';
import { Confirm } from '../../ui/Confirm';
import { Empty } from '../../ui/Empty';
import { SkeletonRows } from '../../ui/Skeleton';
import { toast } from '../../ui/Toast';
import { IconArchive, IconMessage, IconMore, IconPencil, IconTrash } from '../../ui/icons';
import { ROW_ESTIMATE_PX } from '../../ui/tokens';

type Filter = 'active' | 'archived';

export function SessionList({ onOpen }: { onOpen?: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const scroller = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<Filter>('active');
  const [menuFor, setMenuFor] = useState<SessionRow | null>(null);
  const [renaming, setRenaming] = useState<SessionRow | null>(null);
  const [deleting, setDeleting] = useState<SessionRow | null>(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: keys.sessions,
    queryFn: listSessions,
  });

  const rows = useMemo(() => {
    const all = data ?? [];
    // archived_at 是时间戳；RPC 已经排好序（置顶优先 → 最近消息），这里只做筛选
    return filter === 'active'
      ? all.filter((s) => s.archived_at === null)
      : all.filter((s) => s.archived_at !== null);
  }, [data, filter]);

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan: 6,
  });

  const patch = useMutation({
    mutationFn: (p: { id: string; title?: string; archived?: boolean; pinned?: boolean }) => patchSession(p),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: keys.sessions }); },
    onError: (e: Error) => { toast.error(e.message); },
  });

  /**
   * 删除走 005 的 delete_session RPC —— messages / sessions 上刻意没建
   * delete 策略（架构 §7：删除只能经服务端受控入口），这里绕过不了也不该绕过。
   */
  const remove = useMutation({
    mutationFn: async (id: string) => {
      const ok = await deleteViaRpc('delete_session', id);
      if (!ok) throw new Error('这个会话没能删掉，刷新一下再试。');
    },
    onSuccess: () => {
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: keys.sessions });
      toast.ok('会话已删除');
    },
    onError: (e: Error) => toast.error(`没删掉：${e.message}`),
  });

  const openChat = useCallback((id: string) => {
    localStorage.setItem('echosoul.lastSession', id);
    onOpen?.();
    void navigate({ to: '/chat/$sessionId', params: { sessionId: id } });
  }, [navigate, onOpen]);

  const archivedCount = (data ?? []).filter((s) => s.archived_at !== null).length;

  return (
    <div className="session-list">
      <header className="session-head">
        <div className="row">
          <button
            type="button" className={`chip${filter === 'active' ? ' chip-on' : ''}`}
            onClick={() => setFilter('active')}
          >
            进行中
          </button>
          <button
            type="button" className={`chip${filter === 'archived' ? ' chip-on' : ''}`}
            onClick={() => setFilter('archived')}
          >
            已归档{archivedCount > 0 ? ` (${archivedCount})` : ''}
          </button>
        </div>
      </header>

      {isLoading ? (
        <div className="session-skeleton"><SkeletonRows count={5} h={ROW_ESTIMATE_PX} gap={4} /></div>
      ) : isError ? (
        <div className="session-err">
          <p>{error instanceof Error ? error.message : '会话列表没加载出来。'}</p>
          <button type="button" className="btn" onClick={() => void refetch()}>再试一次</button>
        </div>
      ) : rows.length === 0 ? (
        <Empty
          title={filter === 'active' ? '还没有聊过的会话' : '没有归档的会话'}
          hint={filter === 'active'
            ? '从首页挑一个角色，聊上一句就会出现在这里。'
            : '归档只是收起来，不会删除内容。'}
          icon={<IconMessage />}
        />
      ) : (
        <div ref={scroller} className="scroll-pane session-scroll" role="list">
          <div style={{ height: virt.getTotalSize(), position: 'relative', width: '100%' }}>
            {virt.getVirtualItems().map((item) => {
              const s = rows[item.index];
              if (!s) return null;
              return (
                <div
                  key={s.id}
                  data-index={item.index}
                  ref={virt.measureElement}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}
                >
                  <SessionRowButton
                    row={s}
                    onOpen={() => openChat(s.id)}
                    onMenu={() => setMenuFor(s)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {menuFor ? (
        <Sheet title={menuFor.title ?? menuFor.character_names.join('、')} onClose={() => setMenuFor(null)}>
          <div className="col session-menu">
            <button type="button" className="row" onClick={() => { patch.mutate({ id: menuFor.id, pinned: menuFor.pinned_at === null }); setMenuFor(null); }}>
              {menuFor.pinned_at ? '取消置顶' : '置顶'}
            </button>
            <button type="button" className="row" onClick={() => { patch.mutate({ id: menuFor.id, archived: menuFor.archived_at === null }); setMenuFor(null); }}>
              {menuFor.archived_at ? '从归档里放回' : '归档'}
            </button>
            <button type="button" className="row" onClick={() => { const t = menuFor; setMenuFor(null); setRenaming(t); }}>
              <IconPencil size={18} /> <span>改名</span>
            </button>
            <button
              type="button" className="row session-menu-danger"
              onClick={() => { const t = menuFor; setMenuFor(null); setDeleting(t); }}
            >
              <IconTrash size={18} /> <span>删除会话</span>
            </button>
            <p className="muted session-menu-note">
              归档不会删除任何消息；删除会连同聊天记录一起清除，且无法恢复。
            </p>
          </div>
        </Sheet>
      ) : null}

      {renaming ? (
        <RenameSheet row={renaming} onClose={() => setRenaming(null)} onSubmit={(title) => { patch.mutate({ id: renaming.id, title }); setRenaming(null); }} />
      ) : null}

      {deleting ? (
        <Confirm
          title="删除这个会话？"
          body={<>
            <p>会一起删掉的：</p>
            <ul className="ui-confirm-list">
              <li>和 {deleting.character_names.join('、') || '这些角色'} 的全部聊天记录</li>
              <li>这个会话里的置顶与归档状态</li>
            </ul>
            <p>角色的设定、你的额度记录不受影响。</p>
          </>}
          phrase="删除会话"
          confirmLabel="删除"
          busy={remove.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => remove.mutate(deleting.id)}
        />
      ) : null}
    </div>
  );
}

function SessionRowButton({ row, onOpen, onMenu }: { row: SessionRow; onOpen: () => void; onMenu: () => void }) {
  const names = row.character_names.filter(Boolean);
  const label = row.title || names.join('、') || '未命名会话';
  const group = row.kind === 'group' || names.length > 1;
  return (
    <div className={`session-row${row.pinned_at ? ' session-pinned' : ''}`} role="listitem">
      <button type="button" className="session-main" onClick={onOpen}>
        <Avatar
          name={names[0] ?? '?'}
          group={group ? names.map((n) => ({ name: n })) : undefined}
          size={38}
        />
        <span className="grow col session-text">
          <span className="session-name">
            {label}
            {row.pinned_at ? <span className="session-pin">置顶</span> : null}
          </span>
          <span className="session-preview muted">{row.preview || '还没有消息'}</span>
        </span>
        <span className="col session-tail">
          <time className="session-time muted">{relTime(row.last_msg_at)}</time>
          {/* 未读红点：aria-label 说清数字，颜色不是唯一信息载体 */}
          {row.unread > 0
            ? <span className="session-dot" aria-label={`${row.unread} 条未读`}>{row.unread > 9 ? '9+' : row.unread}</span>
            : null}
        </span>
      </button>
      <button type="button" className="session-more" onClick={onMenu} aria-label={`${label} 的更多操作`}>
        <IconMore size={18} />
      </button>
    </div>
  );
}

function RenameSheet({ row, onClose, onSubmit }: { row: SessionRow; onClose: () => void; onSubmit: (t: string) => void }) {
  const [value, setValue] = useState(row.title ?? '');
  return (
    <Sheet title="给这个会话起个名字" onClose={onClose} dirty={value !== (row.title ?? '')}>
      <div className="field">
        <label htmlFor="s-title">只显示给你自己看</label>
        <input
          id="s-title" data-autofocus value={value} maxLength={60}
          placeholder={row.character_names.join('、') || '比如：和那个人深夜的部分'}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) onSubmit(value.trim()); }}
        />
        <p className="muted field-hint">留空则显示角色名。</p>
      </div>
      <div className="sheet-actions">
        <button type="button" className="btn" onClick={onClose}>取消</button>
        <button type="button" className="btn btn-primary" onClick={() => onSubmit(value.trim())}>存好</button>
      </div>
    </Sheet>
  );
}

function relTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000) return '刚刚';
  if (d.toDateString() === now.toDateString()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  if (diff < 6 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
