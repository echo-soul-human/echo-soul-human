/**
 * report.tsx — 举报入口（社区三个板块共用）
 *
 * 为什么单独一个文件：分册-增长运营 §5.4 要求"举报入口每条必备"，而广场、评论、
 * 分享流是三个不同 feature。做成三处各写一遍必然漂移（一处漏了原因选项、
 * 一处忘了带 target id），所以共享同一个抽屉。
 *
 * 依据 25 号专篇第三章：
 *   · 必须让用户选**具体哪一类**（分类决定处置队列与优先级），不能只是"我觉得不好"；
 *   · 必填理由有字数下限 —— 没有细节的举报无法裁决；
 *   · 恶意举报本身是禁止行为（30 号专篇第二章），这句话要写在提交按钮旁边，
 *     这是唯一的威慑位。
 *
 * ⚠ reports 表尚未建（后端没这块）。写入失败时必须说清"举报没送达"，
 *   而不是静默显示"已收到" —— 假承诺比没有更糟。
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { keys, toMessage } from '../rpc';
import { Sheet } from '../../ui/Sheet';
import { toast } from '../../ui/Toast';
import { IconFlag, IconWarning } from '../../ui/icons';

export type ReportTarget =
  | { kind: 'character'; id: string; label: string }
  | { kind: 'comment'; id: string; label: string }
  | { kind: 'share'; id: string; label: string }
  | { kind: 'message'; id: string; label: string };

/** 分类对齐 26 / 27 / 30 号专篇的禁止清单 */
const REASONS = [
  { code: 'minor_sexual', label: '涉及未成年人的性内容', urgent: true },
  { code: 'self_harm', label: '引导自伤或自残', urgent: true },
  { code: 'real_person', label: '冒用真人身份或未经使用他人肖像', urgent: true },
  { code: 'hate', label: '针对现实群体的攻击性内容' },
  { code: 'copyright', label: '抄袭他人的角色卡或文字' },
  { code: 'fraud', label: '诈骗、引流到站外交易' },
  { code: 'spam', label: '刷屏、无意义重复内容' },
  { code: 'other', label: '其他（在下面写清楚）' },
] as const;

type ReasonCode = (typeof REASONS)[number]['code'];

export function ReportSheet({ target, onClose }: { target: ReportTarget; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState<ReasonCode | ''>('');
  const [detail, setDetail] = useState('');
  const [done, setDone] = useState(false);

  const picked = REASONS.find((r) => r.code === reason);
  const canSubmit = reason !== '' && detail.trim().length >= 10;

  const submit = useMutation({
    mutationFn: async () => {
      if (!reason) throw new Error('EMPTY');
      const me = await supabase.auth.getUser();
      if (!me.data.user) throw new Error('UNAUTHORIZED');
      const { error } = await supabase.from('reports').insert({
        user_id: me.data.user.id,
        target_kind: target.kind,
        target_id: target.id,
        reason,
        detail: detail.trim(),
      });
      if (error) throw new Error(toMessage(error.code, error.message));
    },
    onSuccess: () => {
      setDone(true);
      // 举报达阈值会自动隐藏（§5.4），列表要重取才能看到变化
      void qc.invalidateQueries({ queryKey: keys.shareFeed });
      void qc.invalidateQueries({ queryKey: ['plaza'] });
    },
    onError: (e: Error) => {
      // 表还没建时是最常见成因；这里绝不能显示成功
      toast.error(e.message.includes('功能的服务端还没上线') || /relation|does not exist/i.test(e.message)
        ? '举报通道还在建设中，这次没能送达。你可以稍后再试一次。'
        : e.message);
    },
  });

  return (
    <Sheet title={`举报${target.label ? `：${target.label}` : ''}`} onClose={onClose} dirty={!done && (reason !== '' || detail.length > 0)}>
      {done ? (
        <div className="col report-done">
          <p><IconFlag size={17} /> 已经收到了。</p>
          <p className="muted">
            我们会按类别处理：紧急类（涉未成年人、自伤、冒用真人）优先看。
            被举报的内容在核实期间可能被先隐藏 —— 那是隐藏不是删除（25 号专篇第四章）。
          </p>
          <p className="muted">
            如果最后认定没问题，它会出现回来；你的申诉权利在 25 号专篇第六章。
          </p>
          <div className="sheet-actions">
            <button type="button" className="btn btn-primary" onClick={onClose}>知道了</button>
          </div>
        </div>
      ) : (
        <div className="col report-form">
          <fieldset className="report-reasons">
            <legend>是哪一类问题</legend>
            {REASONS.map((r) => (
              <label key={r.code} className="row report-radio">
                <input
                  type="radio" name="report-reason" value={r.code}
                  checked={reason === r.code}
                  onChange={() => setReason(r.code)}
                />
                <span className="grow">{r.label}</span>
                {'urgent' in r && r.urgent ? <span className="report-urgent">加急</span> : null}
              </label>
            ))}
          </fieldset>

          <div className="field">
            <label htmlFor="rp-d">
              具体说明<span className="muted">（至少 10 个字，说清哪里有问题）</span>
            </label>
            <textarea
              id="rp-d" rows={4} maxLength={800} value={detail}
              placeholder={picked?.code === 'copyright'
                ? '比如：这段人设和某平台上「…」的设定逐句相同，原文地址是…'
                : '指出具体内容里的哪一句、哪张图，方便我们直接定位'}
              onChange={(e) => setDetail(e.target.value)}
            />
            <p className="muted field-hint">{detail.trim().length} / 800</p>
          </div>

          <p className="report-caution">
            <IconWarning size={15} />
            <span>虚假或报复性举报属于禁止行为（30 号专篇第二章），会被计入账号处置。</span>
          </p>

          <div className="sheet-actions">
            <button type="button" className="btn" onClick={onClose}>取消</button>
            <button
              type="button" className="btn btn-danger"
              disabled={!canSubmit || submit.isPending}
              onClick={() => submit.mutate()}
            >
              {submit.isPending ? '提交中…' : '提交举报'}
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
