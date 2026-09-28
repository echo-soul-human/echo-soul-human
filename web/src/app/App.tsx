/**
 * App.tsx — 应用外壳（Shell）
 *
 * 结构对齐主流陪伴类产品的信息架构（角色 / 广场 / 消息 / 额度 / 我的），
 * 但视觉完全走我们自己的 token：纸感底色、蓝粉分侧、衬线给角色。
 *
 * 响应式：窄屏底部标签栏，宽屏左侧竖栏。同一套 <NavItems>，两种摆法。
 * 不含业务判断：权益、额度、角色可用性一律由服务端决定（架构 §7）。
 */
import { useEffect, useState } from 'react';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import type { Session } from '@supabase/supabase-js';
import { supabase, IS_DEMO } from '../lib/supabase';
import { useUpdateBanner } from '../lib/useUpdateBanner';
import { AuthGate } from '../features/account/AuthGate';
import { IconUsers, IconPlaza, IconMessage, IconCoins, IconUser } from '../ui/icons';

const NAV = [
  { to: '/', label: '角色', Icon: IconUsers },
  { to: '/plaza', label: '广场', Icon: IconPlaza },
  { to: '/sessions', label: '消息', Icon: IconMessage },
  { to: '/credit', label: '额度', Icon: IconCoins },
  { to: '/settings', label: '我的', Icon: IconUser },
] as const;

function NavItems({ orientation }: { orientation: 'bottom' | 'side' }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <>
      {NAV.map(({ to, label, Icon }) => {
        // 根路径要精确匹配，否则任何页面都会把它点亮
        const active = to === '/' ? pathname === '/' : pathname.startsWith(to);
        return (
          <Link
            key={to}
            to={to}
            className={`nav-item${active ? ' is-active' : ''}`}
            aria-current={active ? 'page' : undefined}
          >
            <Icon size={orientation === 'bottom' ? 22 : 20} />
            <span>{label}</span>
          </Link>
        );
      })}
    </>
  );
}

export default function Shell() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const banner = useUpdateBanner();

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setReady(true);
    });
    // 冷启动必须显式查一次，否则首帧会闪一下"未登录"
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // 横幅必须在鉴权门之外：未登录时它同样要出现 —— 停在登录页的旧构建用户
  // 和从主屏回来的 iOS 用户都属于这一类，藏进登录后的分支里就等于没有。
  const bannerEl = banner ? (
    <button type="button" className="update-banner" onClick={banner.apply}>
      {banner.text}
    </button>
  ) : null;

  const demoChip = IS_DEMO ? (
    <div className="demo-chip" role="status">
      演示模式：数据是示例，不会写入任何地方
      <a href="?demo=0" className="demo-exit">退出</a>
    </div>
  ) : null;

  if (!ready) return <div className="app-shell" aria-busy="true">{bannerEl}</div>;
  if (!session) return <>{bannerEl}{demoChip}<AuthGate /></>;

  return (
    <div className="app-shell has-nav">
      {bannerEl}
      {demoChip}
      <div className="app-body">
        <nav className="app-nav-side" aria-label="主导航">
          <div className="brand-mark" aria-hidden="true">星回</div>
          <NavItems orientation="side" />
        </nav>
        <main className="app-main">
          <Outlet />
        </main>
      </div>
      <nav className="app-nav-bottom" aria-label="主导航">
        <NavItems orientation="bottom" />
      </nav>
    </div>
  );
}
