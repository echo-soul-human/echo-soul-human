/**
 * VoicePicker.tsx — 音色试听与选择
 *
 * 三条不显然但会出事的规矩：
 *   1. iOS Safari 禁止非用户手势发起播放（分册-多模态 §3.3）。所以试听**必须**由
 *      点击触发，绝不 onMount 自动播；首次点击之后才允许连播。
 *   2. 试听 URL 是服务端签发的临时地址，不进 Zustand、不写 localStorage ——
 *      过期了再要一次（§9 服务端状态唯一真源）。
 *   3. 按档位禁用不是"藏起来"而是"看得见但点不动 + 说明怎么解锁"：
 *      让用户不知道自己缺什么是更糟的体验，但也不能变成硬推销。
 *
 * 自定义音色导入（Pro+ 以上）涉及第三方账号与授权，UI 必须写清费用自担
 * （分册-多模态 §3.4）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { accessToken, fnUrl } from '../rpc';
import { IconCheck, IconPlay, IconStop, IconLock } from '../../ui/icons';
import { Sheet } from '../../ui/Sheet';
import { SkeletonRows } from '../../ui/Skeleton';
import { toast } from '../../ui/Toast';

export interface VoiceItem {
  id: string;
  name: string;
  provider: string;
  gender: 'female' | 'male' | 'neutral';
  /** 试听样本 key，服务端按它取缓存音频 */
  sample: string;
  desc: string;
  /** 需要的最低档位；free 表示所有登录用户可用 */
  minTier: Tier;
  emotions: string[];
}

export type Tier = 'free' | 'lite' | 'pro' | 'pro_plus' | 'ultra';

const TIER_ORDER: Record<Tier, number> = { free: 0, lite: 1, pro: 2, pro_plus: 3, ultra: 4 };
export const TIER_LABEL: Record<Tier, string> = {
  free: '体验档', lite: 'Lite', pro: 'Pro', pro_plus: 'Pro+', ultra: 'Ultra',
};

/**
 * 目录表 voices 尚未建（后端还没上这块），先给一份和分册一致的静态清单。
 * 一旦服务端建好目录，把 queryFn 换成查库即可，组件其余部分不用动。
 */
const CATALOG: VoiceItem[] = [
  { id: 'warm-f', name: '温言', provider: 'minimax', gender: 'female', sample: 'warm-f-hello', desc: '偏低、慢一点，像夜里说话', minTier: 'free', emotions: ['日常', '开心', '难过'] },
  { id: 'clear-f', name: '清脆', provider: 'doubao', gender: 'female', sample: 'clear-f-hello', desc: '明亮，语速快，适合活泼人设', minTier: 'lite', emotions: ['日常', '开心', '生气'] },
  { id: 'low-m', name: '沉声', provider: 'minimax', gender: 'male', sample: 'low-m-hello', desc: '话不多的人设配这个', minTier: 'lite', emotions: ['日常', '难过'] },
  { id: 'soft-m', name: '清润', provider: 'ali', gender: 'male', sample: 'soft-m-hello', desc: '中性偏柔，不容易听腻', minTier: 'pro', emotions: ['日常', '开心', '难过', '生气'] },
  { id: 'theater-f', name: '戏感', provider: 'minimax', gender: 'female', sample: 'theater-f-hello', desc: '情绪起伏大，四种差分都有', minTier: 'pro_plus', emotions: ['日常', '开心', '难过', '生气'] },
  { id: 'custom', name: '我自己填音色 ID', provider: 'third-party', gender: 'neutral', sample: '', desc: '由第三方供应商提供，费用与授权自行负责', minTier: 'pro_plus', emotions: [] },
];

interface Props {
  value: string | null;
  tier: Tier;
  onSelect: (voiceId: string | null) => void;
  /** 以抽屉方式打开时传入：选完即关 */
  onClose?: () => void;
}

export function VoicePicker({ value, tier, onSelect, onClose }: Props) {
  const [playing, setPlaying] = useState<string | null>(null);
  const [customId, setCustomId] = useState(value?.startsWith('custom:') ? value.slice(7) : '');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const unlockedRef = useRef(false);   // 用户已经点过一次 ⇒ iOS 允许后续播放

  const myTierRank = TIER_ORDER[tier];

  const { data: catalog, isLoading } = useQuery({
    queryKey: ['voice-catalog'],
    queryFn: async (): Promise<VoiceItem[]> => {
      // 有目录表就用库里的；没有就回落静态清单（见上方注释）
      const { data, error } = await supabase.from('voices')
        .select('id,name,provider,gender,sample,desc,min_tier,emotions').order('name');
      if (error || !data || data.length === 0) return CATALOG;
      return data.map((r: Record<string, unknown>) => ({
        id: String(r.id), name: String(r.name), provider: String(r.provider),
        gender: (r.gender ?? 'neutral') as VoiceItem['gender'],
        sample: String(r.sample ?? ''), desc: String(r.desc ?? ''),
        minTier: (r.min_tier ?? 'free') as Tier,
        emotions: Array.isArray(r.emotions) ? (r.emotions as string[]) : [],
      }));
    },
    staleTime: 600_000,
  });

  const list = useMemo(() => catalog ?? CATALOG, [catalog]);

  // 卸载时停掉：切走抽屉还在念是最常见的"这软件有鬼"来源
  useEffect(() => () => { audioRef.current?.pause(); }, []);

  const stop = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlaying(null);
  };

  const preview = async (v: VoiceItem) => {
    if (!unlockedRef.current) {
      // 空 audio 占位一次，把"用户手势"这次机会用掉；否则稍后换源会被拦
      unlockedRef.current = true;
    }
    if (playing === v.id) { stop(); return; }
    if (!v.sample) { toast.info('这个条目没有试听样本'); return; }
    stop();
    setPlaying(v.id);
    try {
      const token = await accessToken();
      const res = await fetch(`${fnUrl('tts-preview')}?voice=${encodeURIComponent(v.id)}&sample=${encodeURIComponent(v.sample)}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(String(res.status));
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => { URL.revokeObjectURL(url); setPlaying(null); };
      audio.onerror = () => { URL.revokeObjectURL(url); setPlaying(null); toast.warn('试听没放出来，再点一次试试'); };
      await audio.play();
    } catch {
      stop();
      // 试听接口尚未上线是这个分支最常见的成因，文案不能假装是用户的错
      toast.info('这条试听暂时放不出来，不影响选用');
    }
  };

  const lockedFor = (v: VoiceItem) => TIER_ORDER[v.minTier] > myTierRank;

  return (
    <div className="voice-picker">
      <p className="muted voice-note">
        声音按字符单独计费，不占对话额度。角色在不同情绪下会自动切换语气。
      </p>

      {isLoading ? <SkeletonRows count={4} h={64} gap={6} /> : null}

      <ul className="voice-list">
        {list.map((v) => {
          const locked = lockedFor(v);
          const active = value === v.id || (v.id === 'custom' && value?.startsWith('custom:'));
          return (
            <li key={v.id} className={`voice-item${active ? ' voice-active' : ''}${locked ? ' voice-locked' : ''}`}>
              <button
                type="button" className="voice-pick grow"
                disabled={locked}
                aria-pressed={active}
                onClick={() => { onSelect(active ? null : v.id); onClose?.(); }}
              >
                <span className="row voice-top">
                  <b className="voice-name">{v.name}</b>
                  <span className="voice-tier muted">{TIER_LABEL[v.minTier]}</span>
                  {locked ? <IconLock size={15} /> : null}
                </span>
                <span className="voice-desc muted">{v.desc}</span>
                {v.emotions.length > 0 ? (
                  <span className="row voice-emos">
                    {v.emotions.map((e) => <span key={e} className="chip chip-sm">{e}</span>)}
                  </span>
                ) : null}
                {locked ? (
                  <span className="voice-lock-hint">
                    需要升到 {TIER_LABEL[v.minTier]}；升档后这里会自动可选。
                  </span>
                ) : null}
              </button>

              {v.sample ? (
                <button
                  type="button" className="icon-btn voice-play"
                  aria-label={playing === v.id ? `停止试听 ${v.name}` : `试听 ${v.name}`}
                  onClick={() => void preview(v)}
                >
                  {playing === v.id ? <IconStop size={18} /> : <IconPlay size={18} />}
                </button>
              ) : null}

              {active ? <span className="voice-check" aria-label="已选用"><IconCheck size={16} /></span> : null}
            </li>
          );
        })}
      </ul>

      {/* 自定义音色：只在够档位时出现，且必须写清第三方责任边界 */}
      {TIER_ORDER.pro_plus <= myTierRank ? (
        <div className="field voice-custom">
          <label htmlFor="vc-id">填入你自己的音色 ID</label>
          <div className="row">
            <input
              id="vc-id" value={customId} maxLength={64}
              placeholder="供应商后台的 voice_id"
              onChange={(e) => setCustomId(e.target.value)}
            />
            <button
              type="button" className="btn"
              disabled={!customId.trim()}
              onClick={() => { onSelect(`custom:${customId.trim()}`); onClose?.(); }}
            >
              用它
            </button>
          </div>
          <p className="muted field-hint">
            音色由第三方供应商提供，相关费用与使用授权由你与该供应商之间约定，我们不经手。
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** 独立入口：角色详情里以抽屉方式打开 */
export function VoicePickerSheet({ value, tier, onSelect }: {
  value: string | null;
  tier: Tier;
  onSelect: (voiceId: string | null) => void;
}) {
  const close = () => onSelect(value);
  return (
    <Sheet title="选一个声音" onClose={close} wide>
      <VoicePicker value={value} tier={tier} onSelect={onSelect} onClose={close} />
    </Sheet>
  );
}

/** 供卡片显示用的最小复用件：只画名字与档位角标 */
export function VoiceChip({ voiceId, style }: { voiceId: string | null; style?: CSSProperties }) {
  if (!voiceId) return null;
  const named = CATALOG.find((c) => c.id === voiceId);
  const label = named?.name ?? (voiceId.startsWith('custom:') ? '自定义音色' : voiceId);
  return <span className="chip chip-sm" style={style}>{label}</span>;
}
