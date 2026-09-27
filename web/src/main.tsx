/**
 * main.tsx — 应用入口
 *
 * 顺序有讲究：token → base 样式 → 挂载 → 摘骨架屏 → 注册 SW。
 * SW 放在挂载之后注册，避免首屏渲染被 SW 安装流程抢主线程。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import './styles/tokens.generated.css';
import './styles/base.css';
import './styles/components.css';

import { router } from './app/router';
import { RouterProvider } from '@tanstack/react-router';
import { APP_BUILD, BASE_PATH } from './app/version';
import { platform } from './lib/platform';
import { supabaseConfigError } from './lib/supabase';

// 构建号写进 meta，运行时轮询 /version 比对后提示刷新（docs/分册-网页端.md §6.3）
document.head.insertAdjacentHTML(
  'beforeend',
  `<meta name="x-build" content="${APP_BUILD}">`,
);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 对话与余额都是服务端权威，缓存只用于避免同一帧内重复请求
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const container = document.getElementById('root');
if (!container) throw new Error('#root missing');

/**
 * 配置缺失 ⇒ 不挂载，直接画一条可读的失败信息。
 * 让模块抛错去炸白屏的话，线上症状是「页面全白、什么报错都看不见」，
 * 而这条路是北极星指标（新用户首次对话完成率）的第一道门。
 */
if (supabaseConfigError) {
  renderBootFailure(container, supabaseConfigError);
} else {
  createRoot(container).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}

function renderBootFailure(el: HTMLElement, message: string): void {
  document.getElementById('boot')?.remove();
  el.replaceChildren();
  const box = document.createElement('div');
  box.style.cssText = 'max-width:30rem;margin:18vh auto;padding:0 1.25rem;text-align:center';
  const title = document.createElement('h1');
  title.textContent = '星回暂时无法启动';
  const reason = document.createElement('p');
  reason.textContent = message;                       // textContent：不解析成 HTML
  const hint = document.createElement('p');
  hint.textContent = '这是部署配置问题，不是你的账号问题；处理后刷新即可。';
  box.append(title, reason, hint);
  el.append(box);
}

// 骨架屏：等首帧画出来再摘，避免闪白
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    const boot = document.getElementById('boot');
    if (!boot) return;
    boot.classList.add('gone');
    setTimeout(() => boot.remove(), 260);
  });
});

/**
 * Service Worker：只承担 Web Push 与更新提示，零缓存（docs/分册-网页端.md §6.2）。
 * 由 scripts/audit-sw.mjs 在 CI 强制这条。
 */
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  // iOS 非 standalone 时推送不可用，但 SW 仍注册以便加主屏后能用
  try {
    await navigator.serviceWorker.register(`${BASE_PATH}sw.js`, { scope: BASE_PATH });
  } catch (e) {
    console.warn('SW 注册失败', e);
  }
}

// 首屏之后再注册，别抢主线程
if (platform.isIOS() && !platform.isStandalone()) {
  // iOS 上加主屏后才会有推送能力，延后到用户与角色聊起来之后再说
  window.addEventListener('echosoul:first-reply', registerSW, { once: true });
} else {
  window.addEventListener('load', registerSW, { once: true });
}
