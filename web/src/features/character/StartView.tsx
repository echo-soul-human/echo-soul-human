/**
 * StartView.tsx — 首页：挑一个角色开聊
 *
 * 设计约束：
 *   · 首屏不做"请先创建角色"，官方角色直接可聊（I2 定案：先给情绪价值）
 *   · 不显示任何额度/Key 相关字样，除非用户主动去看
 *   · 空态不能是空白页 —— 官方角色还没上架时也要能自建一个聊起来
 */
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { NewCharacterWizard } from './NewCharacterWizard';

interface CharacterRow {
  id: string;
  name: string;
  tagline: string;
  avatar_path: string | null;
  greeting: string;
  tags: string[];
  owner_id: string | null;
}

export function StartView() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [wizard, setWizard] = useState(false);

  const { data: chars, isLoading } = useQuery({
    queryKey: ['characters'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('characters')
        .select('id,name,tagline,avatar_path,greeting,tags,owner_id')
        // 官方 + 自己建的 + 已审核通过的公开卡
        .or('owner_id.is.null,visibility.eq.public,owner_id.not.is.null')
        .order('created_at', { ascending: false })
        .limit(60);
      if (error) throw new Error(error.message);
      return (data ?? []) as CharacterRow[];
    },
  });

  // RLS 已经把未审核通过的公开卡过滤掉了，这里只排序不筛选。
  // 之前写过一个带 || true 的 filter —— 那是恒真的死代码，删了。
  const list = useMemo(() => {
    const all = chars ?? [];
    const rank = (c: CharacterRow) => (c.owner_id === null ? 0 : 1);
    return [...all].sort((a, b) => rank(a) - rank(b));
  }, [chars]);

  const open = useMutation({
    mutationFn: async (characterId: string) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('UNAUTHORIZED');

      // 复用已有会话，避免每次点击都开一个新线程
      const { data: existing } = await supabase
        .from('session_members').select('session_id').eq('character_id', characterId).limit(1);
      const first = existing?.[0];
      if (first?.session_id) {
        const sid = first.session_id;
        const { data: s } = await supabase.from('sessions').select('id,user_id').eq('id', sid).single();
        if (s?.user_id === user.id) return sid;
      }

      const { data: session, error: sErr } = await supabase
        .from('sessions').insert({ user_id: user.id, kind: 'solo' }).select('id').single();
      if (sErr) throw new Error(sErr.message);

      const { error: mErr } = await supabase
        .from('session_members').insert({ session_id: session.id, character_id: characterId, seat: 1 });
      if (mErr) throw new Error(mErr.message);

      // 开场白落库，这样"TA 先说话"在历史里是真实的一条，而不是 UI 假象
      const ch = (chars ?? []).find((c) => c.id === characterId);
      if (ch?.greeting) {
        await supabase.from('messages').insert({
          session_id: session.id, user_id: user.id, role: 'assistant',
          character_id: characterId, content: ch.greeting, origin: 'system',
        });
      }
      return session.id as string;
    },
    onSuccess: (sessionId) => {
      localStorage.setItem('echosoul.lastSession', sessionId);
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      void navigate({ to: '/chat/$sessionId', params: { sessionId } });
    },
  });

  const onPick = useCallback((id: string) => { if (!open.isPending) open.mutate(id); }, [open]);

  return (
    <div className="start">
      <header className="start-head">
        <div>
          <h1>想找谁聊聊？</h1>
          <p className="muted">角色会记住你们说过的话。</p>
        </div>
        <button type="button" className="btn" onClick={() => setWizard(true)}>
          造一个
        </button>
      </header>

      {isLoading ? (
        <div className="start-skeleton" aria-busy="true">
          {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton-card" />)}
        </div>
      ) : list.length === 0 ? (
        <div className="start-empty">
          <p>还没有可聊的角色。</p>
          <button type="button" className="btn btn-primary" onClick={() => setWizard(true)}>
            三句话造一个
          </button>
        </div>
      ) : (
        <ul className="char-grid">
          {list.map((c) => (
            <li key={c.id}>
              <button type="button" className="char-card" onClick={() => onPick(c.id)} disabled={open.isPending}>
                <span className="char-avatar" aria-hidden={!c.avatar_path}>
                  {c.avatar_path
                    ? <img src={c.avatar_path} alt="" loading="lazy" width={56} height={56} />
                    : <span className="char-initial">{c.name.slice(0, 1)}</span>}
                </span>
                <span className="char-meta">
                  <span className="char-name">{c.name}</span>
                  {c.tagline ? <span className="char-tagline muted">{c.tagline}</span> : null}
                </span>
                {c.owner_id === null ? <span className="char-badge">官方</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}

      {open.isError ? (
        <p className="start-err" role="alert">
          没能开起来：{(open.error as Error).message}
        </p>
      ) : null}

      {wizard ? <NewCharacterWizard onClose={() => setWizard(false)} /> : null}
    </div>
  );
}
