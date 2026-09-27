/**
 * MemoryPanel.tsx — "TA 记得的 N 件事"
 *
 * 标题用「TA 记得的」而不是「记忆库」：前者是这个产品的语言，后者是数据库的语言。
 *
 * 三条实现约束：
 *   · 溯源：memories.source_msg_ids + memory_links 指向原消息，点进去跳到会话里
 *     那一条（分册 §7.2 的历史分页不能抢滚动 —— 这里只负责定位请求）。
 *   · 删除走 005 的 delete_memory RPC（memories 上没有前端 delete 策略），
 *     它会同级联清掉向量与溯源行。
 *   · 手动新增走 add_memory；服务端把 salience 固定为 0.950，所以用户写的
 *     一定会被召回 —— UI 上要说"TA 会优先记住你手动加的"。
 */
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { addMemory, deleteViaRpc, keys, type MessageRow } from '../rpc';
import { Sheet } from '../../ui/Sheet';
import { Confirm } from '../../ui/Confirm';
import { Empty } from '../../ui/Empty';
import { SkeletonRows } from '../../ui/Skeleton';
import { toast } from '../../ui/Toast';
import { IconMemory, IconPlus, IconTrash } from '../../ui/icons';

interface MemoryRow {
  id: string;
  kind: 'fact' | 'episode' | 'summary';
  text: string;
  salience: number;
  manual: boolean;
  source_msg_ids: string[];
  session_id: string | null;
  created_at: string;
}

const KIND_LABEL: Record<MemoryRow['kind'], string> = {
  fact: '一件事实',
  episode: '一段经历',
  summary: '一个大致的印象',
};

export interface MemoryPanelProps {
  characterId: string;
  characterName: string;
  /** 当前所在会话：手动新增时挂到它会话下，便于溯源 */
  sessionId?: string;
  onClose?: () => void;
}

export function MemoryPanel({ characterId, characterName, sessionId, onClose }: MemoryPanelProps) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [removing, setRemoving] = useState<MemoryRow | null>(null);
  const [traceFor, setTraceFor] = useState<MemoryRow | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: keys.memories(characterId),
    queryFn: async (): Promise<MemoryRow[]> => {
      const { data: rows, error } = await supabase.from('memories')
        .select('id,kind,text,salience,manual,source_msg_ids,session_id,created_at')
        .eq('character_id', characterId)
        .is('invalidated_at', null)
        .order('salience', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(300);
      if (error) throw new Error(error.message);
      return (rows ?? []) as MemoryRow[];
    },
  });

  // 手动加的排前面：用户最关心"我刚说让 TA 记的那条在不在"
  const list = useMemo(() => {
    const all = data ?? [];
    return [...all].sort((a, b) => Number(b.manual) - Number(a.manual));
  }, [data]);

  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: keys.memories(characterId) });
  }, [qc, characterId]);

  const create = useMutation({
    mutationFn: (text: string) => addMemory(characterId, sessionId ?? null, text),
    onSuccess: () => {
      setDraft('');
      setAdding(false);
      invalidate();
      toast.ok(`${characterName} 会记住这件事`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const drop = useMutation({
    mutationFn: (id: string) => deleteViaRpc('delete_memory', id),
    onSuccess: (ok) => {
      setRemoving(null);
      if (!ok) toast.warn('这条已经不在了');
      else { invalidate(); toast.ok('已经忘了这件事'); }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="memory-panel">
      <header className="panel-head">
        <h3>{list.length > 0 ? `TA 记得的 ${list.length} 件事` : 'TA 还没记住什么'}</h3>
        <p className="muted panel-sub">
          这些是从你们的聊天里整理出来的。写错了可以直接删，也可以自己补一条。
        </p>
      </header>

      {isLoading ? (
        <SkeletonRows count={4} h={62} gap={6} />
      ) : isError ? (
        <div className="panel-err">
          <p>记忆没加载出来。</p>
          <button type="button" className="btn" onClick={() => void refetch()}>再试一次</button>
        </div>
      ) : list.length === 0 && !adding ? (
        <Empty
          title="还没有记下什么"
          hint={<>聊上几句之后，{characterName} 会自己记下你说过的要紧事。<br />也可以现在就告诉 TA 一件，让 TA 记住。</>}
          icon={<IconMemory />}
          action={<button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>加一件</button>}
        />
      ) : (
        <>
          <ul className="memory-list">
            {list.map((m) => (
              <li key={m.id} className={`memory-item${m.manual ? ' memory-manual' : ''}`}>
                <div className="grow col memory-body">
                  <p className="memory-text">{m.text}</p>
                  <div className="row memory-meta">
                    <span className="memory-kind">{KIND_LABEL[m.kind]}</span>
                    {m.manual ? <span className="memory-tag">你让 TA 记的</span> : null}
                    <span className="muted memory-date">{shortDate(m.created_at)}</span>
                    {m.source_msg_ids.length > 0 ? (
                      <button type="button" className="memory-trace" onClick={() => setTraceFor(m)}>
                        看来源
                      </button>
                    ) : (
                      <span className="muted memory-trace-off">没有可追溯的原话</span>
                    )}
                  </div>
                </div>
                <button
                  type="button" className="icon-btn"
                  aria-label={`让 ${characterName} 忘掉：${m.text.slice(0, 18)}`}
                  onClick={() => setRemoving(m)}
                >
                  <IconTrash size={18} />
                </button>
              </li>
            ))}
          </ul>

          {adding ? (
            <div className="field memory-add">
              <label htmlFor="mem-text">要 TA 记住什么</label>
              <textarea
                id="mem-text" data-autofocus value={draft} rows={3} maxLength={500}
                placeholder="比如：我不吃香菜。 / 我周三下午要面试，可能会晚回。"
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="row memory-add-row">
                <span className="grow muted field-hint">
                  最多 500 字。你手动加的，TA 会优先记住。
                </span>
                <button type="button" className="btn" onClick={() => { setAdding(false); setDraft(''); }}>取消</button>
                <button
                  type="button" className="btn btn-primary"
                  disabled={!draft.trim() || create.isPending}
                  onClick={() => create.mutate(draft.trim())}
                >
                  {create.isPending ? '记下中…' : '记住这个'}
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn memory-add-btn" onClick={() => setAdding(true)}>
              <IconPlus size={16} /> <span>再加一件</span>
            </button>
          )}
        </>
      )}

      {traceFor ? (
        <TraceSheet
          memory={traceFor}
          characterName={characterName}
          onClose={() => setTraceFor(null)}
          onJump={(sid) => {
            setTraceFor(null);
            onClose?.();
            void navigate({ to: '/chat/$sessionId', params: { sessionId: sid } });
          }}
        />
      ) : null}

      {removing ? (
        <Confirm
          title="让 TA 忘掉这件事？"
          body={<>
            <p>会删掉这条记忆和它对应的检索结果。</p>
            <p><b>"{removing.text}"</b></p>
            <p className="muted">聊天记录本身不受影响；聊到相关内容时，TA 有可能重新记起来。</p>
          </>}
          phrase="忘掉"
          confirmLabel="让它忘掉"
          busy={drop.isPending}
          onCancel={() => setRemoving(null)}
          onConfirm={() => drop.mutate(removing.id)}
        />
      ) : null}
    </div>
  );
}

/** 溯源抽屉：把这条记忆引用的原始消息找出来 */
function TraceSheet({ memory, characterName, onClose, onJump }: {
  memory: MemoryRow;
  characterName: string;
  onClose: () => void;
  onJump: (sessionId: string) => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['memory-source', memory.id],
    queryFn: async (): Promise<MessageRow[]> => {
      const { data: links, error: lErr } = await supabase.from('memory_links')
        .select('message_id').eq('memory_id', memory.id).limit(20);
      if (lErr) throw new Error(lErr.message);
      const ids = (links ?? []).map((l: { message_id: string }) => l.message_id);
      const picked = ids.length > 0 ? ids : memory.source_msg_ids;
      if (!picked.length) return [];
      const { data: msgs, error: mErr } = await supabase.from('messages')
        .select('id,role,character_id,content,partial,created_at')
        .in('id', picked)
        .order('created_at');
      if (mErr) throw new Error(mErr.message);
      return (msgs ?? []) as MessageRow[];
    },
  });

  const rows = data ?? [];

  return (
    <Sheet title="TA 是从哪里记住的" onClose={onClose}>
      {isLoading ? <SkeletonRows count={3} h={58} gap={6} /> : null}

      {!isLoading && rows.length === 0 ? (
        <p className="muted">
          找不到原话了。可能是那条消息已经被删掉，或者这条记忆是较早的版本里攒下来的。
        </p>
      ) : null}

      <ul className="trace-list">
        {rows.map((m) => (
          <li key={m.id} className={`trace-item ${m.role === 'user' ? 'trace-user' : 'trace-role'}`}>
            <span className="trace-who muted">{m.role === 'user' ? '你' : characterName}</span>
            <p className="trace-text">{m.content}</p>
            <time className="trace-time muted">{shortDate(m.created_at)}</time>
          </li>
        ))}
      </ul>

      {memory.session_id ? (
        <div className="sheet-actions">
          <button type="button" className="btn btn-primary" onClick={() => onJump(memory.session_id as string)}>
            跳到这段聊天
          </button>
        </div>
      ) : (
        <p className="muted field-hint">这段来源所在的会话已经不在了。</p>
      )}
    </Sheet>
  );
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
