/**
 * router.tsx — 路由表
 *
 * 用 code-based TanStack Router：路由参数有类型，跳错路径编译期就报。
 *
 * ⚠ 部署在 GitHub Pages 上，刷新子路由会 404（Pages 不支持 rewrite）。
 *   解法是 dist 里放一个 404.html 把 path 转成 hash 再跳回 index.html，
 *   由 scripts/spa-404.mjs 在构建后生成。不要改成 hash 路由 —— URL 会变丑，
 *   而且分享链接的归因参数会一起变脏。
 */
// 必须最先导入：它是副作用，要在 createRouter 之前把 404.html 带回来的
// hash 路由标记还原成真实 history 状态，否则刷新后永远停在首页。
import '../lib/restoreHashRoute';
import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import Shell from './App';
import { StartView } from '../features/character/StartView';
import { ChatView } from '../features/chat/ChatView';

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}

const rootRoute = createRootRoute({ component: Shell });

const startRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: StartView,
});

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/chat/$sessionId',
  component: ChatView,
  validateSearch: (raw: Record<string, unknown>): { from?: string } =>
    // 分享链接带 ?from=share:<id>，用于统计传播来源（北极星要按来源拆解）。
    // 返回可选键而不是 { from: undefined }，否则每个 navigate 调用都被迫显式传 search。
    typeof raw.from === 'string' ? { from: raw.from } : {},
});

const byokRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/byok',
  component: StartView,        // 配置面板复用同一页，后续替换
});

const routeTree = rootRoute.addChildren([startRoute, chatRoute, byokRoute]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  // 路由基座由 vite 的 base 决定，这里必须跟着走，否则子路由全 404
  basepath: import.meta.env.BASE_URL.replace(/\/$/, ''),
});
