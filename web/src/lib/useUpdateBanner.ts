/**
 * useUpdateBanner.ts — 版本更新提示
 *
 * 规矩（docs/分册-网页端.md §6.3）：
 *   · 只提示，**绝不自动刷新** —— 自动 reload 会把用户正在写的长消息弄没
 *   · 不缓存任何东西，SW 的职责由 audit-sw.mjs 单独守
 */
import { useCallback, useEffect, useState } from 'react';
import { APP_BUILD } from '../app/version';

interface VersionInfo { web?: { build?: string; force_refresh?: boolean } }

const POLL_MS = 5 * 60_000;

export function useUpdateBanner(): { text: string; apply: () => void } | null {
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    async function check() {
      try {
        // no-store：Pages 的 CDN 缓存会让轮询拿到旧值，反而误报
        const res = await fetch(`${import.meta.env.BASE_URL}version.json`, { cache: 'no-store' });
        if (!res.ok) return;
        const v = (await res.json()) as VersionInfo;
        const build = v.web?.build;
        if (!alive || !build || build === APP_BUILD) return;
        setPending(build);
      } catch {
        /* 轮询失败静默：不打扰用户 */
      }
    }

    check();
    const t = setInterval(check, POLL_MS);
    // 回到前台时立刻查一次，比等下一个周期及时
    const onVis = () => { if (document.visibilityState === 'visible') void check(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  // 用户自己点才刷新
  const apply = useCallback(() => window.location.reload(), []);

  if (!pending) return null;
  return { text: '有新版本，点这里刷新', apply };
}
