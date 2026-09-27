/**
 * CharacterDetail.tsx — 角色详情与人设编辑
 *
 * 四块内容：人设文本、示例对话、立绘与情绪差分、声音。外加发布到广场。
 *
 * 三条容易写错的地方：
 *   1. **版本冻结**：改了 persona 或示例对话，服务端会写新版本并冻结旧版本
 *      （架构 §4 规则 2 —— 已发生的记忆不重写）。UI 必须在保存前说清"TA 已有的
 *      记忆不会跟着改"，否则用户会以为改了人设就能改写过去。
 *   2. **差分 4 张起**：分册-多模态 §2.3 要求日常/开心/难过/生气至少四张才有效果；
 *      少于 4 张时明确提示"还差 N 张"，不允许假装已经配好。
 *   3. **发布状态**：publish_character 返回 pending 不等于已公开（25 号专篇 §2.1
 *      进审核队列）。审核未通过时必须把原因显示出来，不能只说"失败了"。
 *
 * 上传走 Storage 公共桶，路径带 user_id 前缀（RLS 按前缀放行）。
 */
import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { keys, publishCharacter, updateCharacter, type ExampleDialog, type PublishResult } from '../rpc';
import { VoicePicker, TIER_LABEL, type Tier } from './VoicePicker';
import { Sheet } from '../../ui/Sheet';
import { Empty } from '../../ui/Empty';
import { Skeleton, SkeletonRows } from '../../ui/Skeleton';
import { Avatar } from '../../ui/Avatar';
import { Confirm } from '../../ui/Confirm';
import { toast } from '../../ui/Toast';
import { IconCheck, IconImage, IconPlus, IconTrash, IconWarning } from '../../ui/icons';

/** 情绪差分的固定标签集（与 prompt 里的隐藏标记同源，别随意增删） */
export const EMOTIONS = ['日常', '开心', '难过', '生气'] as const;
const MIN_PORTRAITS = 4;

interface CharacterFull {
  id: string;
  name: string;
  tagline: string;
  persona_text: string;
  greeting: string;
  example_dialogs: ExampleDialog[];
  avatar_path: string | null;
  portrait_path: string | null;
  voice_profile_id: string | null;
  emotion_portraits: Record<string, string>;
  visibility: 'private' | 'unlisted' | 'public';
  review_status: 'none' | 'pending' | 'approved' | 'rejected';
  published_version: number;
  owner_id: string | null;
}

interface ReviewRow { status: string; reason: string | null; reviewed_at: string | null }

export interface CharacterDetailProps {
  characterId: string;
  tier: Tier;
  onClose?: () => void;
}

export function CharacterDetail({ characterId, tier, onClose }: CharacterDetailProps) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'persona' | 'examples' | 'art' | 'voice'>('persona');
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [lastResult, setLastResult] = useState<PublishResult | null>(null);

  const q = useQuery({
    queryKey: keys.character(characterId),
    queryFn: async (): Promise<CharacterFull> => {
      const { data, error } = await supabase.from('characters')
        .select(`id,name,tagline,persona_text,greeting,example_dialogs,avatar_path,
                 portrait_path,voice_profile_id,emotion_portraits,visibility,
                 review_status,published_version,owner_id`)
        .eq('id', characterId).single();
      if (error) throw new Error(error.message);
      return normalize(data);
    },
  });

  const review = useQuery({
    queryKey: keys.review(characterId),
    queryFn: async (): Promise<ReviewRow | null> => {
      const { data, error } = await supabase.from('card_reviews')
        .select('status,reason,reviewed_at').eq('character_id', characterId).maybeSingle();
      if (error) throw new Error(error.message);
      return (data ?? null) as ReviewRow | null;
    },
    enabled: !q.isLoading,
  });

  // 本地草稿：只在保存前存在，不写进 Zustand（§9）
  const [draft, setDraft] = useState<CharacterFull | null>(null);
  const char = draft ?? q.data ?? null;

  const dirty = useMemo(() => Boolean(draft && q.data && JSON.stringify(draft) !== JSON.stringify(q.data)), [draft, q.data]);

  const save = useMutation({
    mutationFn: () => {
      if (!char) throw new Error('还没加载出来');
      return updateCharacter(characterId, {
        name: char.name,
        tagline: char.tagline,
        persona: char.persona_text,
        greeting: char.greeting,
        examples: char.example_dialogs,
        avatar: char.avatar_path ?? undefined,
        portrait: char.portrait_path ?? undefined,
        voice: char.voice_profile_id ?? undefined,
        emotionPortraits: char.emotion_portraits,
      });
    },
    onSuccess: (version) => {
      setDraft(null);
      void qc.invalidateQueries({ queryKey: keys.character(characterId) });
      void qc.invalidateQueries({ queryKey: keys.characters });
      if (version) {
        // 架构 §4 规则 2：版本冻结 ⇒ 旧记忆不重写。这句必须让用户看到，
        // 否则他会以为改了人设就能改写 TA 已经记住的东西。
        toast.info(`人设升到第 ${version} 版。TA 之前记住的事不会跟着改。`, 5200);
      } else {
        toast.ok('已存好');
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const publish = useMutation({
    mutationFn: () => publishCharacter(characterId),
    onSuccess: (r) => {
      setLastResult(r);
      setConfirmPublish(false);
      void qc.invalidateQueries({ queryKey: keys.character(characterId) });
      if (r === 'approved') toast.ok('已经在广场上了');
      else if (r === 'pending') toast.info('已提交，通过审核后出现在广场');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (q.isLoading) {
    return <div className="char-detail"><Skeleton h={26} w="40%" /><SkeletonRows count={3} h={72} gap={12} /></div>;
  }
  if (q.isError || !char) {
    return (
      <div className="char-detail">
        <Empty
          title="这个角色打不开"
          hint={q.error instanceof Error ? q.error.message : '它可能已经被删除或下架。'}
          action={<button type="button" className="btn" onClick={() => void q.refetch()}>再试一次</button>}
        />
      </div>
    );
  }

  const isOwner = char.owner_id !== null;
  const portraitCount = Object.keys(char.emotion_portraits).filter((k) => char.emotion_portraits[k]).length;

  const patch = (p: Partial<CharacterFull>) => setDraft({ ...(char), ...p });

  return (
    <div className="char-detail">
      <header className="cd-head">
        <Avatar src={char.avatar_path} name={char.name} size={52} />
        <div className="grow col">
          <h2 className="cd-name">{char.name}</h2>
          <p className="muted cd-sub">
            第 {char.published_version} 版 · {isOwner ? '你造的' : '官方角色'}
          </p>
        </div>
        <StatusBadge visibility={char.visibility} review={char.review_status} />
      </header>

      {!isOwner ? (
        <p className="cd-readonly muted">
          官方角色的人设不能改，但你可以复制一份自己调（在首页「造一个」里粘贴它的设定）。
        </p>
      ) : null}

      <nav className="cd-tabs" role="tablist">
        {([['persona', '人设'], ['examples', '示例对话'], ['art', '立绘与情绪'], ['voice', '声音']] as const).map(([k, label]) => (
          <button
            key={k} type="button" role="tab" aria-selected={tab === k}
            className={`cd-tab${tab === k ? ' cd-tab-on' : ''}`}
            onClick={() => setTab(k)}
          >
            {label}
            {k === 'art' && portraitCount > 0 && portraitCount < MIN_PORTRAITS
              ? <span className="cd-warn"><IconWarning size={13} /></span> : null}
          </button>
        ))}
      </nav>

      <div className="cd-body scroll-pane">
        {tab === 'persona' ? (
          <div className="col cd-block">
            <div className="field">
              <label htmlFor="cd-name">叫什么</label>
              <input id="cd-name" value={char.name} maxLength={24} disabled={!isOwner}
                onChange={(e) => patch({ name: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="cd-tag">一句话介绍<span className="muted">（广场上别人看到的就是这句）</span></label>
              <input id="cd-tag" value={char.tagline} maxLength={300} disabled={!isOwner}
                placeholder="比如：话不多，但你说过的每件事他都记得。"
                onChange={(e) => patch({ tagline: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="cd-persona">他是个什么样的人</label>
              <textarea
                id="cd-persona" value={char.persona_text} rows={9} maxLength={6000} disabled={!isOwner}
                placeholder={'写行为，不写形容词。\n"表面冷淡但从不说谎"比"高冷温柔"有效得多。'}
                onChange={(e) => patch({ persona_text: e.target.value })}
              />
              <p className="muted field-hint">
                {char.persona_text.length} / 6000。这里说的"性格"会被服务端拼进一段你永远看不到的锁——
                这是设计如此（C8 定案），不是出 bug。
              </p>
            </div>
            <div className="field">
              <label htmlFor="cd-greet">TA 先开口说什么</label>
              <input id="cd-greet" value={char.greeting} maxLength={200} disabled={!isOwner}
                onChange={(e) => patch({ greeting: e.target.value })} />
            </div>
          </div>
        ) : null}

        {tab === 'examples' ? (
          <ExamplesEditor
            disabled={!isOwner}
            value={char.example_dialogs}
            onChange={(v) => patch({ example_dialogs: v })}
          />
        ) : null}

        {tab === 'art' ? (
          <ArtEditor
            characterId={characterId}
            disabled={!isOwner}
            avatar={char.avatar_path}
            portrait={char.portrait_path}
            emotions={char.emotion_portraits}
            onAvatar={(p) => patch({ avatar_path: p })}
            onPortrait={(p) => patch({ portrait_path: p })}
            onEmotion={(map) => patch({ emotion_portraits: map })}
          />
        ) : null}

        {tab === 'voice' ? (
          <div className="cd-block">
            <VoicePicker
              value={char.voice_profile_id}
              tier={tier}
              onSelect={(v) => { patch({ voice_profile_id: v }); }}
            />
          </div>
        ) : null}
      </div>

      <footer className="cd-foot">
        {isOwner ? (
          <>
            <button
              type="button" className="btn btn-primary"
              disabled={!dirty || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? '保存中…' : dirty ? '保存改动' : '没有改动'}
            </button>
            <button
              type="button" className="btn"
              onClick={() => setConfirmPublish(true)}
              disabled={publish.isPending}
            >
              发布到广场
            </button>
            {onClose ? <button type="button" className="btn" onClick={onClose}>关闭</button> : null}
          </>
        ) : onClose ? (
          <button type="button" className="btn" onClick={onClose}>关闭</button>
        ) : null}
      </footer>

      <PublishNotice result={lastResult} review={review.data ?? null} char={char} tier={tier} />

      {confirmPublish ? (
        <Confirm
          title="发到广场，就是给别人看了"
          danger={false}
          body={<PublishPreview char={char} />}
          confirmLabel="确认提交审核"
          busy={publish.isPending}
          onCancel={() => setConfirmPublish(false)}
          onConfirm={() => publish.mutate()}
        />
      ) : null}
    </div>
  );
}

// ── 示例对话 ───────────────────────────────────────────
function ExamplesEditor({ value, onChange, disabled }: {
  value: ExampleDialog[]; onChange: (v: ExampleDialog[]) => void; disabled: boolean;
}) {
  return (
    <div className="col cd-block">
      <p className="muted field-hint">
        定人设靠示例对话，不靠形容词。写三到五组就够 —— 每组是"你说一句 / TA 回一句"。
      </p>

      {value.length === 0 ? (
        <Empty
          title="还没有示例对话"
          hint="没有示例的话，TA 的语气全靠模型猜，最容易出戏。"
          icon={<IconImage />}
          action={!disabled ? <button type="button" className="btn btn-primary" onClick={() => onChange([{ user: '', role: '' }])}>加第一组</button> : undefined}
        />
      ) : null}

      <ul className="ex-list">
        {value.map((ex, i) => (
          <li key={i} className="ex-item">
            <div className="field">
              <label htmlFor={`ex-u-${i}`}>你说</label>
              <textarea
                id={`ex-u-${i}`} rows={2} maxLength={600} value={ex.user} disabled={disabled}
                onChange={(e) => { const n = [...value]; n[i] = { ...ex, user: e.target.value }; onChange(n); }}
              />
            </div>
            <div className="field">
              <label htmlFor={`ex-r-${i}`}>TA 回</label>
              <textarea
                id={`ex-r-${i}`} rows={2} maxLength={600} value={ex.role} disabled={disabled}
                className="role-text"
                onChange={(e) => { const n = [...value]; n[i] = { ...ex, role: e.target.value }; onChange(n); }}
              />
            </div>
            {!disabled ? (
              <button
                type="button" className="icon-btn ex-del"
                aria-label={`删掉第 ${i + 1} 组示例`}
                onClick={() => onChange(value.filter((_, j) => j !== i))}
              >
                <IconTrash size={17} />
              </button>
            ) : null}
          </li>
        ))}
      </ul>

      {!disabled ? (
        <button type="button" className="btn" onClick={() => onChange([...value, { user: '', role: '' }])}>
          <IconPlus size={16} /> <span>再加一组</span>
        </button>
      ) : null}
    </div>
  );
}

// ── 立绘与情绪差分 ─────────────────────────────────────
function ArtEditor({ characterId, avatar, portrait, emotions, onAvatar, onPortrait, onEmotion, disabled }: {
  characterId: string;
  avatar: string | null;
  portrait: string | null;
  emotions: Record<string, string>;
  onAvatar: (p: string | null) => void;
  onPortrait: (p: string | null) => void;
  onEmotion: (m: Record<string, string>) => void;
  disabled: boolean;
}) {
  const filled = EMOTIONS.filter((e) => emotions[e]);
  const missing = MIN_PORTRAITS - filled.length;

  return (
    <div className="col cd-block">
      <div className="art-row">
        <UploadSlot label="头像" path={avatar} circle onChange={onAvatar} disabled={disabled} bucket="avatars" userId={characterId} />
        <UploadSlot label="主立绘" path={portrait} onChange={onPortrait} disabled={disabled} bucket="portraits" userId={characterId} />
      </div>

      <h4 className="art-sub">情绪差分</h4>
      <p className="muted field-hint">
        上传四张以上，TA 说话时会随情绪换图 —— 不用生成图，只要你自己传，效果立竿见影。
        {missing > 0
          ? <span className="art-missing"> 还差 {missing} 张才算配齐。</span>
          : <span className="art-ok"> 已经配齐。</span>}
      </p>

      <div className="art-grid">
        {EMOTIONS.map((e) => (
          <UploadSlot
            key={e}
            label={e}
            path={emotions[e] ?? null}
            disabled={disabled}
            bucket="portraits"
            userId={characterId}
            onChange={(p) => {
              const next = { ...emotions };
              if (p) next[e] = p; else delete next[e];
              onEmotion(next);
            }}
          />
        ))}
      </div>

      {/* 允许加第五第六种情绪，但四张起步这条由 UI 守住 */}
      <ExtraEmotions
        emotions={emotions}
        onChange={onEmotion}
        disabled={disabled}
        characterId={characterId}
      />
    </div>
  );
}

const EXTRA_EMOTIONS = ['害羞', '担心', '认真', '想念'];

function ExtraEmotions({ emotions, onChange, disabled, characterId }: {
  emotions: Record<string, string>;
  onChange: (m: Record<string, string>) => void;
  disabled: boolean;
  characterId: string;
}) {
  // 只在本地记"这次要新加哪几种"，图传上来才写进 emotions ——
  // 否则会出现一条空 path 的情绪项，前端切图时拿到 undefined 直接不显示。
  const [pending, setPending] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const base = EMOTIONS as readonly string[];
  const extras = Object.keys(emotions).filter((k) => !base.includes(k));
  const offered = [...extras, ...EXTRA_EMOTIONS.filter((e) => !extras.includes(e))];

  return (
    <div className="art-extra">
      <button type="button" className="btn btn-ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? '收起其他情绪' : `加其他情绪${extras.length ? `（已有 ${extras.length}）` : ''}`}
      </button>
      {open ? (
        <>
          <div className="row art-chips">
            {offered.map((e) => (
              <button
                key={e} type="button" disabled={disabled}
                className={`chip${emotions[e] ? ' chip-on' : ''}`}
                onClick={() => setPending((p) => (p.includes(e) || emotions[e] ? p : [...p, e]))}
              >
                {e}{emotions[e] ? ' · 已配图' : ''}
              </button>
            ))}
          </div>
          {pending.length > 0 ? (
            <div className="art-grid">
              {pending.map((e) => (
                <UploadSlot
                  key={e} label={e} path={emotions[e] ?? null} disabled={disabled}
                  bucket="portraits" userId={characterId}
                  onChange={(p) => {
                    const next = { ...emotions };
                    if (p) next[e] = p; else delete next[e];
                    onChange(next);
                    setPending((list) => list.filter((x) => x !== e));
                  }}
                />
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** 单个上传位：拖拽 + 点击都支持（分册 §12 PC 拖拽上传） */
function UploadSlot({ label, path, onChange, circle, disabled, bucket, userId }: {
  label: string;
  path: string | null;
  onChange: (p: string | null) => void;
  circle?: boolean;
  disabled?: boolean;
  bucket: string;
  userId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);

  const upload = useCallback(async (file: File) => {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      toast.warn('只能传 PNG / JPG / WebP');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.warn('单张不超过 5MB');
      return;
    }
    setBusy(true);
    try {
      const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
      // 路径带自己的 user 段：Storage 策略按前缀放行，别人的目录写不进去
      const me = await supabase.auth.getUser();
      const p = `${me.data.user?.id ?? 'anon'}/${bucket}/${userId}-${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from('media').upload(p, file, { upsert: false });
      if (error) throw new Error(/already exists|duplicate/i.test(error.message) ? '这张已经传过了' : error.message);
      const { data: pub } = supabase.storage.from('media').getPublicUrl(p);
      onChange(pub.publicUrl);
      toast.ok(`${label}传好了`);
    } catch (e) {
      // media 桶还没建时是最常见成因，别把它说成用户的操作有问题
      toast.error(e instanceof Error && e.message.includes('bucket')
        ? '图片存储桶还没开，这次传不上去。'
        : `没传上去：${e instanceof Error ? e.message : '未知原因'}`);
    } finally {
      setBusy(false);
    }
  }, [bucket, label, onChange, userId]);

  return (
    <div className={`slot${circle ? ' slot-circle' : ''}${over ? ' slot-over' : ''}`}>
      <span className="slot-label">{label}</span>
      <label
        className={`slot-box${disabled ? ' slot-disabled' : ''}`}
        onDragOver={(ev) => { if (!disabled) { ev.preventDefault(); setOver(true); } }}
        onDragLeave={() => setOver(false)}
        onDrop={(ev) => {
          if (disabled) return;
          ev.preventDefault();
          setOver(false);
          const f = ev.dataTransfer.files?.[0];
          if (f) void upload(f);
        }}
      >
        <input
          type="file" accept="image/png,image/jpeg,image/webp" hidden disabled={disabled}
          onChange={(ev) => { const f = ev.target.files?.[0]; if (f) void upload(f); ev.target.value = ''; }}
        />
        {path
          ? <img src={path} alt={`${label}预览`} width={120} height={120} loading="lazy" />
          : <span className="slot-hint muted">{busy ? '上传中…' : '点一下或把图拖进来'}</span>}
      </label>
      {path ? (
        <button type="button" className="btn btn-ghost slot-clear" onClick={() => onChange(null)}>去掉</button>
      ) : null}
    </div>
  );
}

// ── 发布相关 ───────────────────────────────────────────
function StatusBadge({ visibility, review }: { visibility: CharacterFull['visibility']; review: CharacterFull['review_status'] }) {
  if (visibility === 'private') return <span className="cd-badge">仅自己可见</span>;
  if (review === 'approved') return <span className="cd-badge cd-badge-ok"><IconCheck size={13} /> 广场可见</span>;
  if (review === 'pending') return <span className="cd-badge cd-badge-warn">审核中</span>;
  if (review === 'rejected') return <span className="cd-badge cd-badge-bad">未通过审核</span>;
  return <span className="cd-badge">未发布</span>;
}

/** 发布前必须明示"具体哪些内容会被公开"（增长 §5.4） */
function PublishPreview({ char }: { char: CharacterFull }) {
  return (
    <div className="col pub-preview">
      <p>提交审核后，下面这些内容会出现在广场上，任何登录用户都能看到：</p>
      <ul className="ui-confirm-list">
        <li><b>名字</b>：{char.name}</li>
        <li><b>一句话介绍</b>：{char.tagline || '（空）'}</li>
        <li><b>头像与立绘</b>：{char.avatar_path ? '已上传' : '没有头像'}{char.portrait_path ? ' · 有主立绘' : ''}</li>
        <li><b>完整人设文本</b>：{char.persona_text.slice(0, 80)}{char.persona_text.length > 80 ? '…' : ''}</li>
        <li><b>示例对话</b>：{char.example_dialogs.length} 组</li>
      </ul>
      <p className="pub-warn">
        <IconWarning size={16} /> <span>你们的聊天记录、你的昵称和账号不会被公开。</span>
      </p>
      <p className="muted">
        人设文本一旦公开，被别人抄走之后我们无法帮你追回 —— 20 号专篇里有说明。不想公开的写法就别发。
      </p>
    </div>
  );
}

function PublishNotice({ result, review, char, tier }: {
  result: PublishResult | null;
  review: ReviewRow | null;
  char: CharacterFull;
  tier: Tier;
}) {
  if (result === 'tier_too_low') {
    return (
      <p className="cd-notice cd-notice-warn" role="status">
        发布到广场需要 Pro 及以上档位，你现在是 {TIER_LABEL[tier]}。
      </p>
    );
  }
  if (result === 'not_owner') {
    return <p className="cd-notice cd-notice-warn" role="status">这个角色的作者不是你，发不了。</p>;
  }
  if (char.review_status === 'rejected') {
    return (
      <div className="cd-notice cd-notice-bad" role="status">
        <p><b>没有通过审核。</b></p>
        <p>{review?.reason ? `原因：${plainReason(review.reason)}` : '审核意见还在同步，稍后再回来看一眼。'}</p>
        <p className="muted">可以改完之后重新提交；申诉走自动复审，不需要找客服（25 号专篇 §6）。</p>
      </div>
    );
  }
  if (char.review_status === 'pending' || result === 'pending') {
    return (
      <p className="cd-notice" role="status">
        已提交，正在排队审核。通过后自动出现在广场上，这期间只有你自己能看到。
      </p>
    );
  }
  return null;
}

/** 审核原因是内部术语，转成用户能懂的话 */
function plainReason(code: string): string {
  switch (code) {
    case 'sexual_minor': return '涉及未成年人的性化内容，这类内容一律不允许。';
    case 'real_person': return '疑似真人肖像或冒用真实身份。';
    case 'self_harm': return '包含引导自伤的内容。';
    case 'hate': return '包含针对现实群体的攻击性内容。';
    case 'spam': return '被判定为批量发布的无效内容。';
    case 'copyright': return '与他人已公开的角色卡高度雷同。';
    default: return code;
  }
}

function normalize(raw: Record<string, unknown>): CharacterFull {
  return {
    id: String(raw.id),
    name: String(raw.name ?? ''),
    tagline: String(raw.tagline ?? ''),
    persona_text: String(raw.persona_text ?? ''),
    greeting: String(raw.greeting ?? ''),
    example_dialogs: Array.isArray(raw.example_dialogs)
      ? (raw.example_dialogs as unknown[]).map((x) => {
          const o = x as Record<string, unknown>;
          return { user: String(o.user ?? o.u ?? ''), role: String(o.role ?? o.a ?? '') };
        }).filter((x) => x.user || x.role)
      : [],
    avatar_path: (raw.avatar_path as string | null) ?? null,
    portrait_path: (raw.portrait_path as string | null) ?? null,
    voice_profile_id: (raw.voice_profile_id as string | null) ?? null,
    emotion_portraits: (raw.emotion_portraits as Record<string, string> | null) ?? {},
    visibility: (raw.visibility as CharacterFull['visibility']) ?? 'private',
    review_status: (raw.review_status as CharacterFull['review_status']) ?? 'none',
    published_version: Number(raw.published_version ?? 0),
    owner_id: (raw.owner_id as string | null) ?? null,
  };
}

/** 抽屉外壳：从会话右上角或广场卡片打开 */
export function CharacterDetailSheet(props: CharacterDetailProps & { tier: Tier }) {
  return (
    <Sheet title="这个角色" onClose={props.onClose ?? (() => {})} wide>
      <CharacterDetail {...props} />
    </Sheet>
  );
}
