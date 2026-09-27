/**
 * NewCharacterWizard.tsx — 三句话建卡（任务 1-15）
 *
 * 验收要求：新用户**不看说明**就能建成并聊上。
 * 所以这里刻意只要三个字段，其余高级字段（示例对话、边界、差分立绘）
 * 全部后置到角色详情页，不在第一次就摊开。
 */
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { supabase } from '../../lib/supabase';

const PRESETS = [
  { key: 'cool', name: '高冷但在意你', persona: '话不多，回得短。表面冷淡，但会记住对方说过的每件事，并在不该出现的地方表现出来。不主动解释自己的关心。' },
  { key: 'sweet', name: '甜，会主动找你', persona: '语气轻快，喜欢用短句和语气词。会主动问对方今天过得怎么样，听到不好的事会认真担心。' },
  { key: 'witty', name: '会贫，但不油', persona: '爱开玩笑，接梗快，但知道什么时候该收。反感被敷衍，聊到认真处会突然正经。' },
];

export function NewCharacterWizard({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [oneLine, setOneLine] = useState('');
  const [greeting, setGreeting] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const create = async () => {
    if (!name.trim()) { setErr('先给它起个名字'); return; }
    setBusy(true);
    setErr(null);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('登录状态没了，重新进来一下');

      const { data: char, error: cErr } = await supabase.from('characters').insert({
        owner_id: user.id,
        name: name.trim(),
        tagline: oneLine.trim(),
        // 一句话人设。系统提示由服务端拼装，用户看不到也不需要看到（C8 定案）
        persona_text: oneLine.trim() || name.trim(),
        greeting: greeting.trim(),
        visibility: 'private',
      }).select('id').single();
      if (cErr) throw new Error(cErr.message);

      const { data: session, error: sErr } = await supabase
        .from('sessions').insert({ user_id: user.id, kind: 'solo' }).select('id').single();
      if (sErr) throw new Error(sErr.message);

      const { error: mErr } = await supabase
        .from('session_members').insert({ session_id: session.id, character_id: char.id, seat: 1 });
      if (mErr) throw new Error(mErr.message);

      if (greeting.trim()) {
        await supabase.from('messages').insert({
          session_id: session.id, user_id: user.id, role: 'assistant',
          character_id: char.id, content: greeting.trim(), origin: 'system',
        });
      }

      localStorage.setItem('echosoul.lastSession', session.id);
      onClose();
      await navigate({ to: '/chat/$sessionId', params: { sessionId: session.id } });
    } catch (e) {
      // 槽位用尽时服务端会拒，这里要把它翻译成人话而不是抛原始错误
      const msg = (e as Error).message ?? '';
      setErr(/row-level security|permission/i.test(msg)
        ? '这个档位的自建角色数量到上限了。'
        : msg || '没建成，再试一次。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="新建角色">
      <div className="sheet-inner">
        <h2>三句话，造一个人</h2>

        <div className="field">
          <label htmlFor="c-name">叫什么</label>
          <input id="c-name" value={name} maxLength={24} placeholder="比如：陈默"
            onChange={(e) => setName(e.target.value)} autoFocus />
        </div>

        <div className="field">
          <label htmlFor="c-line">他是个什么样的人</label>
          <textarea id="c-line" value={oneLine} maxLength={400} rows={3}
            placeholder="一句话就够。比如：话不多，但你说过的每件事他都记得。"
            onChange={(e) => setOneLine(e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="c-greet">
            他先开口会说什麼<span className="muted">（可留空）</span>
          </label>
          <input id="c-greet" value={greeting} maxLength={200} placeholder="比如：回来了？"
            onChange={(e) => setGreeting(e.target.value)} />
        </div>

        <div className="presets" role="group" aria-label="快速开始">
          <span className="muted">没头绪？挑一个：</span>
          {PRESETS.map((p) => (
            <button key={p.key} type="button" className="chip"
              onClick={() => { setOneLine(p.persona); if (!name) setName(p.name.slice(0, 2)); }}>
              {p.name}
            </button>
          ))}
        </div>

        {err ? <p className="sheet-err" role="alert">{err}</p> : null}

        <div className="sheet-actions">
          <button type="button" className="btn" onClick={onClose}>取消</button>
          <button type="button" className="btn btn-primary" onClick={create} disabled={busy}>
            {busy ? '正在造…' : '就这样，开始聊'}
          </button>
        </div>
        <p className="muted sheet-note">
          之后还能改他的说话方式、加示例对话、配声音和立绘。
        </p>
      </div>
    </div>
  );
}
