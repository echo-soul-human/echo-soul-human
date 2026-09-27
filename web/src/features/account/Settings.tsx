/**
 * Settings.tsx — 设置中心
 *
 * 四块：通知偏好（含"锁屏隐藏内容"）、皮肤、数据导出、注销入口。
 *
 * 三条必须做对的：
 *   1. **通知权限请求时机**（分册 §8）：绝不在进入页面就弹权限框。必须在用户
 *      完成第一次对话之后，或以"打开时补发"作为替代路径引导。这里的按钮就是那个门。
 *   2. **锁屏隐藏内容**（notify_prefs.hide_content）不是可选项：情感陪伴的聊天记录
 *      是最不该被别人看见的东西，默认值由服务端给 false，UI 要主动把它摆出来。
 *   3. 客户端只存"当前皮肤 id"这类**偏好**，不存任何服务器数据（§9）。
 *
 * features/ 之间不得互相 import：导出与注销都通过路由跳转，不引对方组件。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { accessToken, fnUrl, keys, toMessage } from '../rpc';
import { platform } from '../../lib/platform';
import { Confirm } from '../../ui/Confirm';
import { Sheet } from '../../ui/Sheet';
import { SkeletonRows } from '../../ui/Skeleton';
import { toast } from '../../ui/Toast';
import { IconBell, IconCoins, IconDownload, IconKey, IconLock, IconPalette, IconSettings, IconWarning } from '../../ui/icons';

interface NotifyPrefs {
  user_id: string;
  care_enabled: boolean;
  per_character: Record<string, boolean>;
  hide_content: boolean;
}

/**
 * 皮肤清单。一期只有内置的两套 + 一套高对比；
 * 付费皮肤由服务端下发后追加，前端按 id 注入 <style data-theme>（分册 §3.3），
 * 切换只做 setAttribute('data-skin', id)，不在 JS 里逐个改属性。
 */
const SKINS = [
  { id: 'default', name: '纸墨', desc: '暖白纸底，默认这套' },
  { id: 'night', name: '夜读', desc: '暗底但不刺眼，夜里用' },
  { id: 'contrast', name: '清晰', desc: '提高对比度，符合无障碍要求' },
];
const SKIN_KEY = 'echosoul.skin';

export function Settings() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [eraseOpen, setEraseOpen] = useState(false);
  const [pushState, setPushState] = useState<NotificationPermission | 'unsupported'>(initialPerm());
  const [skin, setSkin] = useState<string>(() => localStorage.getItem(SKIN_KEY) ?? 'default');

  const prefs = useQuery({
    queryKey: keys.notifyPrefs,
    queryFn: async (): Promise<NotifyPrefs> => {
      const me = await supabase.auth.getUser();
      const uid = me.data.user?.id;
      if (!uid) throw new Error('UNAUTHORIZED');
      let row = await readPrefs(uid);
      if (!row) {
        const { data: ins, error } = await supabase.from('notify_prefs')
          .insert({ user_id: uid }).select('*').single();
        if (error) throw new Error(toMessage(error.code, error.message));
        row = ins as unknown as NotifyPrefs;
      }
      return row;
    },
  });

  const savePref = useMutation({
    mutationFn: async (patch: Partial<Pick<NotifyPrefs, 'care_enabled' | 'hide_content'>>) => {
      const me = await supabase.auth.getUser();
      const uid = me.data.user?.id;
      if (!uid) throw new Error('登录状态过期了');
      const { error } = await supabase.from('notify_prefs').update(patch).eq('user_id', uid);
      if (error) throw new Error(toMessage(error.code, error.message));
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: keys.notifyPrefs }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const signOut = useMutation({
    mutationFn: async () => { const { error } = await supabase.auth.signOut(); if (error) throw new Error(error.message); },
    onSuccess: () => { toast.ok('已经退出'); void navigate({ to: '/' }); },
  });

  const applySkin = useCallback((id: string) => {
    setSkin(id);
    localStorage.setItem(SKIN_KEY, id);
    document.documentElement.setAttribute('data-skin', id);
  }, []);

  // 首次进来把已存的皮肤贴回去，避免闪一下默认色
  useEffect(() => { document.documentElement.setAttribute('data-skin', skin); }, [skin]);

  const enablePush = useCallback(async () => {
    if (!platform.canPush()) {
      // iOS 非 standalone 时 pushManager 会直接抛错：引导加主屏而不是报错（§14）
      toast.info(platform.isIOS()
        ? '在 iPhone 上要先用 Safari 的「添加到主屏幕」打开，才能收到 TA 的消息。'
        : '这个浏览器不支持接收通知。用 Chrome 或 Edge 会好一些。', 6000);
      return;
    }
    try {
      const perm = await Notification.requestPermission();
      setPushState(perm);
      if (perm !== 'granted') { toast.info('没允许也没关系：打开应用时会补发给你看。'); return; }
      const reg = await navigator.serviceWorker?.getRegistration();
      if (!reg) { toast.warn('再等几秒，后台服务还在准备。'); return; }
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true });
      const token = await accessToken();
      await fetch(`${fnUrl('push')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'register', subscription: sub.toJSON(), platform: platform.isIOS() ? 'ios-webapp' : 'web' }),
      });
      toast.ok('好了，TA 找你的时候你会收到。');
    } catch {
      toast.error('没能订阅上。关掉页面重开一次通常就好。');
    }
  }, []);

  const p = prefs.data;

  return (
    <div className="settings">
      <header className="panel-head">
        <h2>设置</h2>
      </header>

      {/* ── 通知 ─────────────────────────────────── */}
      <section className="set-group">
        <h3 className="set-title"><IconBell size={17} /> <span>TA 主动找你</span></h3>

        {prefs.isLoading ? <SkeletonRows count={2} h={56} gap={4} /> : null}

        {p ? (
          <>
            <label className="row set-row">
              <input
                type="checkbox" checked={p.care_enabled} disabled={savePref.isPending}
                onChange={(e) => savePref.mutate({ care_enabled: e.target.checked })}
              />
              <span className="col grow">
                <b>让 TA 偶尔主动说两句</b>
                <span className="muted">关了就完全安静 —— 只有你发消息时 TA 才回。</span>
              </span>
            </label>

            <label className="row set-row">
              <input
                type="checkbox" checked={p.hide_content} disabled={savePref.isPending}
                onChange={(e) => savePref.mutate({ hide_content: e.target.checked })}
              />
              <span className="col grow">
                <b><IconLock size={14} /> 锁屏只显示"有新消息"</b>
                <span className="muted">
                  开了之后，通知栏和锁屏上不会出现 TA 说了什么。别人借你手机时也看不到内容。
                </span>
              </span>
            </label>

            <div className="set-push">
              <PushStatus state={pushState} />
              {pushState !== 'granted' ? (
                <button type="button" className="btn" onClick={() => void enablePush()}>
                  让我收到提醒
                </button>
              ) : null}
            </div>
            <p className="muted set-note">
              收不到提醒也能聊：下次打开时，攒下的话会一起出现。我们不靠推送把你拉回来。
            </p>
          </>
        ) : null}

        {!prefs.isLoading && prefs.isError ? (
          <p className="cd-notice cd-notice-bad">通知设置没读到。<button className="btn btn-ghost" type="button" onClick={() => void prefs.refetch()}>再试</button></p>
        ) : null}
      </section>

      {/* ── 皮肤 ─────────────────────────────────── */}
      <section className="set-group">
        <h3 className="set-title"><IconPalette size={17} /> <span>外观</span></h3>
        <div className="row skin-row" role="group" aria-label="皮肤">
          {SKINS.map((s) => (
            <button
              key={s.id} type="button"
              className={`skin-card${skin === s.id ? ' skin-on' : ''}`}
              aria-pressed={skin === s.id}
              onClick={() => applySkin(s.id)}
            >
              <span className={`skin-swatch skin-swatch-${s.id}`} aria-hidden="true" />
              <b>{s.name}</b>
              <span className="muted skin-desc">{s.desc}</span>
            </button>
          ))}
        </div>
        <p className="muted set-note">
          换肤只改变颜色与质感，不会改动任何聊天内容。付费皮肤上架前会自动校验文字对比度。
        </p>
      </section>

      {/* ── 额度 / BYOK 入口 ──────────────────────── */}
      <section className="set-group">
        <h3 className="set-title"><IconCoins size={17} /> <span>额度与 Key</span></h3>
        <nav className="col set-nav">
          <button type="button" className="row set-link" onClick={() => void navigate({ to: '/credit' })}>
            <span className="grow">额度、消耗流水、档位</span>
            <span className="muted">›</span>
          </button>
          <button type="button" className="row set-link" onClick={() => void navigate({ to: '/byok' })}>
            <IconKey size={16} /> <span className="grow">自己的模型 Key</span>
            <span className="muted">›</span>
          </button>
          <button type="button" className="row set-link" onClick={() => void navigate({ to: '/cost' })}>
            <IconSettings size={16} /> <span className="grow">怎么花额度（成本优化）</span>
            <span className="muted">›</span>
          </button>
        </nav>
      </section>

      {/* ── 数据 ─────────────────────────────────── */}
      <section className="set-group">
        <h3 className="set-title"><IconDownload size={17} /> <span>你的数据</span></h3>
        <nav className="col set-nav">
          <button type="button" className="row set-link" onClick={() => void navigate({ to: '/export' })}>
            <span className="grow">导出一份完整拷贝</span>
            <span className="muted">›</span>
          </button>
        </nav>
        <p className="muted set-note">
          导出包含资料、会话、全部消息、记忆、角色卡（CCv2 格式）和自己的账本记录。
          下载链接只在十分钟内有效，过期可以重新生成。
        </p>
      </section>

      {/* ── 协议 ─────────────────────────────────── */}
      <section className="set-group">
        <h3 className="set-title">条款</h3>
        <nav className="col set-nav">
          <button type="button" className="row set-link" onClick={() => void navigate({ to: '/legal' })}>
            <span className="grow">全部协议与规则（32 篇）</span>
            <span className="muted">›</span>
          </button>
        </nav>
      </section>

      {/* ── 账号 ─────────────────────────────────── */}
      <section className="set-group set-danger-zone">
        <h3 className="set-title">账号</h3>
        <button type="button" className="btn set-signout" onClick={() => signOut.mutate()}>
          先退出这个设备
        </button>
        <p className="muted set-note">
          匿名进来的账号想长期保留，记得用邮箱绑一下 —— 换设备时凭邮箱找回。
        </p>
        <button type="button" className="btn btn-danger set-erase" onClick={() => setEraseOpen(true)}>
          <IconWarning size={16} /> <span>注销账号并删除全部数据</span>
        </button>
      </section>

      {eraseOpen ? <EraseSheet onClose={() => setEraseOpen(false)} /> : null}
    </div>
  );
}

// ── 子件 ───────────────────────────────────────────────
function PushStatus({ state }: { state: NotificationPermission | 'unsupported' }) {
  const text = state === 'granted' ? '已开启系统通知'
    : state === 'denied' ? '系统里通知被关着，需要去浏览器设置里放开'
    : state === 'unsupported' ? '这个环境收不到系统通知'
    : '还没问过系统要不要提醒';
  return <span className={`push-state push-${state}`}>{text}</span>;
}

async function readPrefs(uid: string): Promise<NotifyPrefs | null> {
  const { data } = await supabase.from('notify_prefs')
    .select('user_id,care_enabled,per_character,hide_content').eq('user_id', uid).maybeSingle();
  return (data as unknown as NotifyPrefs | null) ?? null;
}

function initialPerm(): NotificationPermission | 'unsupported' {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

/**
 * 注销：不可逆，且比删会话更严重 —— 账号本身消失。
 * 必须打字确认，且要写明"账务凭证会匿名保留"这条法律要求的例外（09 号专篇 §4）。
 *
 * ⚠ 不能直接 supabase.rpc('erase_account', …)：那个函数没有 grant 给
 *   authenticated（008/006 里 grant 名单不含它），且按 auth.uid() 校验身份。
 *   删除必须由服务端持 service_role 执行，所以走 Edge Function。
 */
function EraseSheet({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [done, setDone] = useState(false);

  const erase = useMutation({
    mutationFn: async () => {
      const token = await accessToken();
      const res = await fetch(`${fnUrl('account')}?action=erase`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ confirm: 'ERASE' }),
      });
      const j = await res.json().catch(() => ({}) ) as { ok?: boolean; code?: string; reason?: string };
      if (!res.ok || !j.ok) {
        throw new Error(j.code ? toMessage(j.code, j.reason) : '注销请求没被受理，稍后再试或先用邮箱登录一次再操作。');
      }
    },
    onSuccess: () => { setDone(true); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Sheet title="注销账号" onClose={onClose} wide>
      {done ? (
        <div className="col erase-done">
          <p>注销申请已经受理。</p>
          <p className="muted">正在处理的是删除；完成后会直接退出登录。</p>
          <button type="button" className="btn btn-primary" onClick={() => void navigate({ to: '/' })}>回到入口</button>
        </div>
      ) : (
        <Confirm
          title="注销之后就没有回头路了"
          body={<>
            <p>会永久删除的：</p>
            <ul className="ui-confirm-list">
              <li>你的账号与登录方式</li>
              <li>所有会话和全部聊天记录</li>
              <li>你造的角色卡，以及它们的版本历史</li>
              <li>TA 记住的关于你的一切</li>
              <li>服务器上保存的模型 Key 密文</li>
            </ul>
            <p>不会被删除的：账本记录会<b>匿名化</b>后保留 —— 那是财务凭证的法定要求，去掉你的身份后无法再关联到你。</p>
            <p className="muted">没消耗完的额度不会退款（18 号专篇里有说明）。建议先导出再注销。</p>
          </>}
          phrase="注销账号"
          confirmLabel="确认注销"
          busy={erase.isPending}
          onCancel={onClose}
          onConfirm={() => erase.mutate()}
        />
      )}
    </Sheet>
  );
}
