/**
 * ExportData.tsx — 数据导出（09 / 12 号专篇承诺的功能项）
 *
 * 流程：请求 → 服务端组装 → 轮询进度 → 拿到**限时签名链接** → 下载。
 * 链接过期后必须能重新签发，不能让用户以为"我的东西没了"。
 *
 * 三条实现约束：
 *   · export-tmp 桶的签名 URL 只有 10 分钟（后端与数据库 §7），所以页面上要倒计时，
 *     并在过期时把按钮变成"再要一个链接"而不是灰着。
 *   · 服务端状态一律 TanStack Query；轮询用 refetchInterval，不自建 setInterval
 *     （那样会在组件卸载后继续跑，且切后台时 iOS 会挂起它）。
 *   · 明文 Key 永远不在导出里（byok_secrets 对前端零授权，服务端也不读出来）。
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { accessToken, fnUrl, toMessage } from '../rpc';
import { Empty } from '../../ui/Empty';
import { Skeleton } from '../../ui/Skeleton';
import { toast } from '../../ui/Toast';
import { IconDownload, IconRefresh, IconWarning } from '../../ui/icons';

type Stage = 'idle' | 'queued' | 'packing' | 'ready' | 'expired' | 'failed';

interface JobState {
  job_id: string;
  stage: Stage;
  /** 0-100；服务端给的是已处理条目数占比 */
  percent: number;
  bytes: number | null;
  items: { sessions: number; messages: number; memories: number; characters: number; ledger: number } | null;
  url: string | null;
  expires_at: string | null;
  error?: string;
}

const STAGE_TEXT: Record<Stage, string> = {
  idle: '还没开始',
  queued: '排上了，等着开工',
  packing: '正在把你的记录打包',
  ready: '好了，可以下载',
  expired: '下载链接已经过期',
  failed: '这次没成功',
};

export function ExportData() {
  const [jobId, setJobId] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: async (): Promise<string> => {
      const token = await accessToken();
      const res = await fetch(`${fnUrl('export')}?action=start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ format: 'json' }),
      });
      const j = await res.json().catch(() => ({}) ) as { job_id?: string; code?: string; reason?: string };
      if (!j.job_id) throw new Error(j.code ? toMessage(j.code, j.reason) : '这次没能开始导出，稍后再试。');
      return j.job_id;
    },
    onSuccess: (id) => setJobId(id),
    onError: (e: Error) => toast.error(e.message),
  });

  const job = useQuery({
    queryKey: ['export-job', jobId],
    enabled: Boolean(jobId),
    queryFn: async (): Promise<JobState> => {
      const token = await accessToken();
      const res = await fetch(`${fnUrl('export')}?action=status&job_id=${encodeURIComponent(String(jobId))}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('STATUS_' + res.status);
      return await res.json() as JobState;
    },
    // 未完成时每 2.5s 问一次；完成后停止轮询 —— 已完成还继续打接口是纯浪费
    refetchInterval: (q) => {
      const s = (q.state.data as JobState | undefined)?.stage;
      return s === 'ready' || s === 'failed' || s === 'expired' ? false : 2500;
    },
    retry: 1,
  });

  const resign = useMutation({
    mutationFn: async () => {
      const token = await accessToken();
      const res = await fetch(`${fnUrl('export')}?action=relink&job_id=${encodeURIComponent(String(jobId))}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      const j = await res.json().catch(() => ({}) ) as { url?: string; expires_at?: string; code?: string; reason?: string };
      if (!j.url) throw new Error(j.code ? toMessage(j.code, j.reason) : '这个包已经不在了，需要重新导出一份。');
      return j;
    },
    onSuccess: () => { void job.refetch(); toast.ok('新链接好了，十分钟内有效'); },
    onError: (e: Error) => toast.error(e.message),
  });

  const state = job.data;
  const secondsLeft = useMemo(() => (state?.expires_at ? Math.max(0, Math.round((new Date(state.expires_at).getTime() - Date.now()) / 1000)) : 0), [state?.expires_at]);

  return (
    <div className="export-page">
      <header className="panel-head">
        <h3>导出你的数据</h3>
        <p className="muted panel-sub">
          一份完整的拷贝，给你自己留着。格式是 JSON，角色卡部分是 CCv2 标准，别的工具也能读。
        </p>
      </header>

      <ul className="export-scope">
        <li>个人资料与会话列表</li>
        <li>全部聊天记录（含 TA 主动发的）</li>
        <li>TA 记住的每一条，以及它们的来源</li>
        <li>你造的角色卡：人设、示例对话、立绘地址</li>
        <li>你自己的额度流水</li>
      </ul>
      <p className="muted export-note">
        里面<b>不会</b>有：你的模型 Key（服务器上也只存密文，取不出来）、别人的分享数据。
      </p>

      {!jobId && !start.isPending ? (
        <Empty
          title="还没有发起过导出"
          hint="导出在服务端慢慢攒，不占用你这台设备；攒好给你一个十分钟有效的下载链接。"
          icon={<IconDownload />}
          action={
            <button type="button" className="btn btn-primary" onClick={() => start.mutate()}>
              开始导出
            </button>
          }
        />
      ) : null}

      {start.isPending && !jobId ? (
        <div className="export-loading"><Skeleton h={20} w="50%" /><Skeleton h={60} /></div>
      ) : null}

      {state ? (
        <section className={`export-state export-${state.stage}`}>
          <div className="row">
            <h4 className="grow">{STAGE_TEXT[state.stage]}</h4>
            {state.bytes ? <span className="muted">{fmtBytes(state.bytes)}</span> : null}
          </div>

          {(state.stage === 'queued' || state.stage === 'packing') ? (
            <>
              <ProgressBar percent={state.percent} />
              <p className="muted export-percent">{state.percent}% · 消息多的时候要几分钟，可以先把这页放着。</p>
            </>
          ) : null}

          {state.items ? (
            <dl className="export-counts">
              <div><dt>会话</dt><dd>{state.items.sessions}</dd></div>
              <div><dt>消息</dt><dd>{state.items.messages.toLocaleString()}</dd></div>
              <div><dt>记忆</dt><dd>{state.items.memories}</dd></div>
              <div><dt>角色</dt><dd>{state.items.characters}</dd></div>
              <div><dt>流水</dt><dd>{state.items.ledger}</dd></div>
            </dl>
          ) : null}

          {state.stage === 'ready' && state.url ? (
            <>
              <a className="btn btn-primary" href={state.url} download rel="noopener noreferrer">
                <IconDownload size={16} /> <span>下载这一份</span>
              </a>
              {/* ★ 10 分钟窗口必须倒计时显示：链接静默失效是最容易被误解成"数据丢了" */}
              <p className={`export-timer${secondsLeft < 120 ? ' export-timer-low' : ''}`} role="timer" aria-live="polite">
                链接还剩 {fmtDuration(secondsLeft)}，过期后可以再生成一个。
              </p>
            </>
          ) : null}

          {state.stage === 'expired' ? (
            <>
              <p className="export-warn"><IconWarning size={16} /> <span>这个下载链接到期了。文件还在，重新签一个就行。</span></p>
              <button type="button" className="btn btn-primary" disabled={resign.isPending} onClick={() => resign.mutate()}>
                <IconRefresh size={16} /> <span>{resign.isPending ? '生成中…' : '再要一个链接'}</span>
              </button>
            </>
          ) : null}

          {state.stage === 'failed' ? (
            <>
              <p className="export-warn"><IconWarning size={16} /> <span>{state.error ?? '导出这一步出错了，你的数据没有受影响。'}</span></p>
              <button type="button" className="btn" onClick={() => { setJobId(null); start.mutate(); }}>重来一次</button>
            </>
          ) : null}

          {state.stage === 'ready' ? (
            <button type="button" className="btn btn-ghost" onClick={() => setJobId(null)}>
              导出完了，关掉
            </button>
          ) : null}
        </section>
      ) : null}

      {job.isError && jobId ? (
        <p className="export-warn" role="alert">
          <IconWarning size={16} />
          <span>查不到进度了。<button type="button" className="btn btn-ghost" onClick={() => void job.refetch()}>再查一次</button></span>
        </p>
      ) : null}
    </div>
  );
}

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="xp-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <span className="xp-fill" style={{ width: `${Math.min(100, Math.max(2, percent))}%` }} />
    </div>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDuration(sec: number): string {
  if (sec <= 0) return '已经到期';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m} 分 ${String(s).padStart(2, '0')} 秒` : `${s} 秒`;
}
