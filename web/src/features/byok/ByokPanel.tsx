/**
 * ByokPanel.tsx — 自带 Key（Bring Your Own Key）
 *
 * ★ 界面上必须写清"Key 只存服务端，不下载到设备"。这句话不是营销文案，
 *   它对应数据库里两道真实的门：
 *     · byok_secrets 对 authenticated / anon **零授权**（006），密文根本查不到；
 *     · byok_profiles 只有 select 策略，insert/update/delete 全部 with check (false)，
 *       所以前端连"改个标签"都做不到 —— 写入只能经 Edge Function。
 *   既然前端不能写，本组件的所有增删改都必须走函数，不许直接 .from().delete()。
 *
 * 校验失败必须给中文可懂原因（03 号专篇 §4）：上游返回的是英文 error.message，
 * 直接透传等于把 HTTP 库的报错端给用户。translateVerifyReason() 负责这层翻译。
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProviderKind } from '../../types/generated/api';
import { supabase } from '../../lib/supabase';
import { accessToken, fnUrl, keys, toMessage } from '../rpc';
import { Empty } from '../../ui/Empty';
import { Sheet } from '../../ui/Sheet';
import { Confirm } from '../../ui/Confirm';
import { SkeletonRows } from '../../ui/Skeleton';
import { toast } from '../../ui/Toast';
import { IconCheck, IconKey, IconPlus, IconTrash, IconWarning } from '../../ui/icons';

export interface ByokRow {
  id: string;
  kind: ProviderKind;
  label: string;
  base_url: string;
  model: string;
  /** ****abcd —— 后端视图里唯一能拿到的形态，永远不是完整 Key */
  key_mask: string;
  enabled: boolean;
  last_used_at: string | null;
  created_at: string;
}

const PROVIDER_LABEL: Record<ProviderKind, string> = { openai: 'OpenAI 兼容', anthropic: 'Anthropic' };

type VerifyState = 'unknown' | 'ok' | 'fail';

export function ByokPanel() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ByokRow | null>(null);
  // 校验结果属于本次会话的瞬时状态：刷新后重新验，不进 Zustand、不进 localStorage
  const [verify, setVerify] = useState<Record<string, { state: VerifyState; detail: string }>>({});

  const q = useQuery({
    queryKey: keys.byok,
    queryFn: async (): Promise<ByokRow[]> => {
      const { data, error } = await supabase.from('byok_profiles_public')
        .select('id,kind,label,base_url,model,key_mask,enabled,last_used_at,created_at')
        .order('created_at', { ascending: false });
      if (error) throw new Error(toMessage(error.code, error.message));
      return (data ?? []) as ByokRow[];
    },
  });

  const rows = useMemo(() => q.data ?? [], [q.data]);

  const runVerify = useMutation({
    mutationFn: async (id: string) => {
      const token = await accessToken();
      const res = await fetch(`${fnUrl('byok')}?action=verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ profile_id: id }),
      });
      const body = await res.json().catch(() => ({ ok: false, reason: `HTTP ${res.status}` })) as
        { ok?: boolean; reason?: string; code?: string };
      // 校验失败是**业务结果**而不是异常：要把原因显示在那一行上，
      // 所以这里不 throw，只有取不到令牌这类真故障才走 onError。
      return {
        state: (body.ok ? 'ok' : 'fail') as VerifyState,
        detail: body.ok ? '' : (body.code ? toMessage(body.code, body.reason) : translateVerifyReason(body.reason ?? '')),
      };
    },
    onSuccess: (r, id) => { setVerify((v) => ({ ...v, [id]: r })); },
    onError: (e: Error, id) => {
      setVerify((v) => ({ ...v, [id]: { state: 'fail', detail: e.message } }));
    },
  });

  const drop = useMutation({
    mutationFn: async (id: string) => {
      const token = await accessToken();
      const res = await fetch(`${fnUrl('byok')}?action=delete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ profile_id: id }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}) ) as { code?: string; reason?: string };
        throw new Error(j.code ? toMessage(j.code, j.reason) : '没删掉，稍后再试。');
      }
    },
    onSuccess: () => {
      setRemoving(null);
      void qc.invalidateQueries({ queryKey: keys.byok });
      toast.ok('Key 已从服务器删除');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="byok-panel">
      <header className="panel-head">
        <h3>用自己的模型 Key</h3>
        <p className="muted panel-sub">
          配上自己的 Key 之后，和 TA 聊天不再消耗这里的额度 —— 费用由你的模型账号出。
        </p>
      </header>

      {/* ★ 这句是产品承诺，也是数据库现实：密文表对前端角色零授权 */}
      <p className="byok-promise">
        <IconKey size={16} />
        <span><b>Key 只存服务端，不下载到设备。</b>这台设备上不会保存你的 Key，任何页面也读不回完整 Key；列表里显示的 ****后四位只是标识。</span>
      </p>

      {q.isLoading ? <SkeletonRows count={2} h={72} gap={8} /> : null}

      {!q.isLoading && rows.length === 0 ? (
        <Empty
          title="还没有配过 Key"
          hint="不配也能聊 —— 用我们这边的额度就行。配了之后那一档额度就省下来留给别的角色。"
          icon={<IconKey />}
          action={<button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>加一把 Key</button>}
        />
      ) : null}

      {rows.length > 0 ? (
        <>
          <ul className="byok-list">
            {rows.map((r) => {
              const v = verify[r.id];
              return (
                <li key={r.id} className={`byok-item${r.enabled ? '' : ' byok-off'}`}>
                  <div className="grow col byok-main">
                    <div className="row byok-top">
                      <b className="byok-label">{r.label || PROVIDER_LABEL[r.kind]}</b>
                      <span className="chip chip-sm">{PROVIDER_LABEL[r.kind]}</span>
                      {!r.enabled ? <span className="muted byok-disabled">已停用</span> : null}
                    </div>
                    <p className="muted byok-meta">{r.model || '未指定模型'} · {r.key_mask}</p>
                    <p className="muted byok-url" title={r.base_url}>{shortUrl(r.base_url)}</p>
                    {r.last_used_at ? <p className="muted byok-used">上次用到：{fmtDate(r.last_used_at)}</p> : null}

                    {v && v.state === 'fail' ? (
                      <p className="byok-fail" role="alert">
                        <IconWarning size={15} /> <span>{v.detail}</span>
                      </p>
                    ) : null}
                    {v && v.state === 'ok' ? (
                      <p className="byok-ok" role="status"><IconCheck size={15} /> <span>能用，刚才验过了。</span></p>
                    ) : null}
                  </div>

                  <div className="col byok-ops">
                    <button
                      type="button" className="btn btn-ghost"
                      disabled={runVerify.isPending && runVerify.variables === r.id}
                      onClick={() => runVerify.mutate(r.id)}
                    >
                      校验一下
                    </button>
                    <button
                      type="button" className="icon-btn"
                      aria-label={`删除 ${r.label || PROVIDER_LABEL[r.kind]}`}
                      onClick={() => setRemoving(r)}
                    >
                      <IconTrash size={18} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          <button type="button" className="btn byok-add" onClick={() => setAdding(true)}>
            <IconPlus size={16} /> <span>再加一把</span>
          </button>
        </>
      ) : null}

      <details className="byok-how">
        <summary>去哪拿 Key？要多少钱？</summary>
        <ol className="muted">
          <li>到模型服务商的控制台建一个 API Key（通常叫 API Keys / 凭证）。</li>
          <li>把它填进来，同时确认 Base URL 和模型名。国内中转站要给的是中转站的地址。</li>
          <li>费用直接从那个账号扣，和我们无关；我们先按你填的余额提示一次还剩多少。</li>
        </ol>
        <p className="muted">
          Key 泄露或怀疑被人复制过，第一件事是去服务商那边吊销，再回来这里删掉记录。
        </p>
      </details>

      {adding ? (
        <AddKeySheet
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); void qc.invalidateQueries({ queryKey: keys.byok }); }}
        />
      ) : null}

      {removing ? (
        <Confirm
          title="删掉这把 Key？"
          body={<>
            <p>会一起删掉的：</p>
            <ul className="ui-confirm-list">
              <li>这条配置（{removing.label || PROVIDER_LABEL[removing.kind]} · {removing.key_mask}）</li>
              <li>服务器上保存的密文 —— 删了就找不回来，得重新填一遍</li>
            </ul>
            <p className="muted">聊天记录和额度都不受影响。如果怀疑 Key 泄露过，请同时去服务商那边吊销。</p>
          </>}
          phrase="删除 Key"
          confirmLabel="删除"
          busy={drop.isPending}
          onCancel={() => setRemoving(null)}
          onConfirm={() => drop.mutate(removing.id)}
        />
      ) : null}
    </div>
  );
}

// ── 新增 ───────────────────────────────────────────────
function AddKeySheet({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<ProviderKind>('openai');
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [model, setModel] = useState('gpt-4o-mini');
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const token = await accessToken();
      const res = await fetch(`${fnUrl('byok')}?action=create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ kind, label, api_key: key, base_url: baseUrl, model }),
      });
      const j = await res.json().catch(() => ({}) ) as { ok?: boolean; code?: string; reason?: string };
      if (!res.ok || !j.ok) {
        throw new Error(j.code ? toMessage(j.code, j.reason) : (j.reason ?? '没存上，再试一次。'));
      }
    },
    onSuccess: () => {
      // 明文 Key 只在这次请求里存在过：不写 state 之外的任何地方，成功后立刻清空
      toast.ok('存好了。要不要现在校验一下？');
      onSaved();
    },
    onError: (e: Error) => setErr(e.message),
  });

  const canSubmit = key.trim().length >= 12 && /^https:\/\//.test(baseUrl);

  return (
    <Sheet title="加一把自己的 Key" onClose={onClose} wide dirty={key.length > 0 || label.length > 0}>
      <div className="col byok-form">
        <p className="byok-promise">
          <IconKey size={16} />
          <span>Key 只存服务端，不下载到设备。提交之后这一栏就清空，页面上再也看不到完整内容。</span>
        </p>

        <div className="field">
          <label htmlFor="bk-kind">类型</label>
          <select
            id="bk-kind" value={kind}
            onChange={(e) => {
              const k = e.target.value as ProviderKind;
              setKind(k);
              setBaseUrl(k === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1');
            }}
          >
            <option value="openai">OpenAI 兼容（含各家中转）</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="bk-key">API Key</label>
          <input
            id="bk-key" data-autofocus type="password" value={key} maxLength={200}
            autoComplete="off" spellCheck={false} inputMode="text" autoCapitalize="off"
            placeholder="sk-…"
            onChange={(e) => setKey(e.target.value)}
          />
          <p className="muted field-hint">粘贴进来就行，不用加别的前缀。</p>
        </div>

        <div className="field">
          <label htmlFor="bk-label">给它起个名<span className="muted">（可选，多把 Key 时好区分）</span></label>
          <input id="bk-label" value={label} maxLength={40} placeholder="比如：我的主力号"
            onChange={(e) => setLabel(e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="bk-url">Base URL</label>
          <input id="bk-url" value={baseUrl} maxLength={200} spellCheck={false}
            onChange={(e) => setBaseUrl(e.target.value)} />
          <p className="muted field-hint">填本机或内网地址会被拒 —— 那是防 SSRF 的硬规则，不是设置问题。</p>
        </div>

        <div className="field">
          <label htmlFor="bk-model">模型名</label>
          <input id="bk-model" value={model} maxLength={80} spellCheck={false}
            onChange={(e) => setModel(e.target.value)} />
        </div>

        {err ? <p className="sheet-err" role="alert">{err}</p> : null}

        <div className="sheet-actions">
          <button type="button" className="btn" onClick={onClose}>取消</button>
          <button
            type="button" className="btn btn-primary"
            disabled={!canSubmit || save.isPending}
            onClick={() => { setErr(null); save.mutate(); }}
          >
            {save.isPending ? '存入中…' : '存到服务器'}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

/**
 * 上游报错 → 人话。
 * 服务商给的 message 全是英文且各不相同，逐条精确匹配不可能，
 * 所以按关键词族归类；实在认不出来时用兜底句 + 原文摘要，
 * 绝不把整段英文直接端给用户。
 */
export function translateVerifyReason(raw: string): string {
  const s = raw.toLowerCase();
  if (/invalid.api.key|incorrect api key|authentication|unauthorized|api_key_invalid/.test(s)) {
    return 'Key 不对。多半是复制时少了字符，或者这把 Key 已经被吊销了 —— 回服务商那边确认一下。';
  }
  if (/billing|quota|insufficient|credit balance/.test(s)) {
    return 'Key 是有效的，但那个账号没有余额或超出配额了。先去充一下。';
  }
  if (/rate_limit|too many requests|429/.test(s)) {
    return '服务商那边限流了。Key 本身没问题，过一会儿再验一次。';
  }
  if (/model_not_found|does not exist|unknown model|invalid model/.test(s)) {
    return '这个模型名在服务商那边找不到。检查拼写，或换一个你有权限的模型。';
  }
  if (/region|country|not available in/.test(s)) {
    return '这个 Key 所在的地区不提供该服务。' ;
  }
  if (/econnrefused|enotfound|timeout|fetch failed|network/.test(s)) {
    return '连不上那个地址。检查 Base URL 是否写全，以及服务商是否需要代理才能访问。';
  }
  if (/self-signed|certificate|tls/.test(s)) {
    return '那个地址的证书有问题，为了安全我们没有继续连接。';
  }
  if (/blocked|private ip|internal address/.test(s)) {
    return 'Base URL 指向了本机或内网地址，这类地址不允许使用。';
  }
  return `服务商回了这么一句：${trim(raw, 120)}。拿着这句话去问服务商最快。`;
}

function trim(s: string, n: number): string { return s.length > n ? `${s.slice(0, n)}…` : s; }

function shortUrl(u: string): string {
  try { return new URL(u).host; } catch { return trim(u, 40); }
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
