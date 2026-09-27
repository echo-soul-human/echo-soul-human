/**
 * router.tsx — 路由表
 *
 * 用 code-based TanStack Router：路由参数有类型，跳错路径编译期就报。
 *
 * ⚠ 部署在 GitHub Pages 上，刷新子路由会 404（Pages 不支持 rewrite）。
 *   解法是构建期生成 404.html 把 path 编码进 hash 再跳回 index.html，
 *   由 scripts/spa-404.mjs + lib/restoreHashRoute.ts 配对完成。
 *   不要改成 hash 路由 —— URL 会变丑，而且分享链接的归因参数会一起变脏。
 *
 * ⚠ 新增路由必须同时加进这里，否则 <Link to="/xxx"> 会在 tsc 阶段直接报错
 *   （这正是想要的效果：拼错路径过不了编译）。
 */
import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import Shell from './App';
import { StartView } from '../features/character/StartView';
import { ChatView } from '../features/chat/ChatView';
import { ByokPanel } from '../features/byok/ByokPanel';
import { CreditPage } from '../features/billing/CreditPage';
import { CostPage } from '../features/billing/CostPage';
import { Settings } from '../features/account/Settings';
import { ExportData } from '../features/account/ExportData';
import { LegalIndex } from '../features/legal/LegalIndex';
import { LegalDoc } from '../features/legal/LegalDoc';
import { Plaza } from '../features/community/Plaza';
import { ShareFeed } from '../features/community/ShareFeed';

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
    // 分享链接带 ?from=share:<id>，用于按来源拆解首次对话完成率。
    // 返回可选键而不是 { from: undefined }，否则每个 navigate 都被迫显式传 search。
    typeof raw.from === 'string' ? { from: raw.from } : {},
});

const byokRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/byok',
  component: ByokPanel,
});

const creditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/credit',
  component: CreditPage,
});

const costRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/cost',
  component: CostPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: Settings,
});

const exportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/export',
  component: ExportData,
});

const legalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/legal',
  component: LegalIndex,
});

const legalDocRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/legal/$docNo',
  component: LegalDoc,
  // a = 条款锚点，让「10 号 §6 用户权利」这类引用能直达
  validateSearch: (raw: Record<string, unknown>): { a?: string } =>
    typeof raw.a === 'string' ? { a: raw.a } : {},
});

const plazaRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/plaza',
  component: Plaza,
});

const feedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/feed',
  component: ShareFeed,
});

const routeTree = rootRoute.addChildren([
  startRoute,
  chatRoute,
  byokRoute,
  creditRoute,
  costRoute,
  settingsRoute,
  exportRoute,
  legalRoute,
  legalDocRoute,
  plazaRoute,
  feedRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  // 路由基座由 vite 的 base 决定，这里必须跟着走，否则子路由全 404
  basepath: import.meta.env.BASE_URL.replace(/\/$/, ''),
});
