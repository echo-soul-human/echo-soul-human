/**
 * App.tsx — 应用外壳（Shell）
 *
 * 职责：鉴权门 → 骨架 → 更新提示。
 * 不含业务判断：权益、额度、角色可用性一律由服务端决定（架构 §7）。
 * 路由表在同目录 router.tsx，本文件不创建 router，避免循环引用。
 */
import { useEffect, useState } from 'react';
import { Outlet } from '@tanstack/react-router';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { useUpdateBanner } from '../lib/useUpdateBanner';
import { AuthGate } from '../features/account/AuthGate';

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

  if (!ready) return <div className="app-shell" aria-busy="true" />;
  if (!session) return <AuthGate />;

  return (
    <div className="app-shell">
      {banner ? (
        <button type="button" className="update-banner" onClick={banner.apply}>
          {banner.text}
        </button>
      ) : null}
      <Outlet />
    </div>
  );
}
