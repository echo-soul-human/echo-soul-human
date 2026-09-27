/**
 * restoreHashRoute.ts — 还原 404.html 带回来的真实路径
 *
 * 场景：GitHub Pages 不 rewrite，刷新子路由会命中 404.html，
 * 后者把 path+query 编码成 #r=... 再跳回 index.html。
 * 这里在 router 创建之前把它还原成正常的 history 状态，
 * 这样 TanStack Router 看到的就是真实路径，URL 也不会留 hash。
 *
 * 必须在 createRouter 之前执行，所以由 router.tsx 作为第一个副作用导入。
 */
import { BASE_PATH } from '../app/version';

/**
 * #r= 里带回来的是**应用内**路径（/chat/7），而站点挂在 base 下
 * （/echo-soul-human/）。少了这一步拼接，URL 就脱离 router 的 basepath，
 * 表现为「还原后仍然渲染不出来，且再刷一次又 404」。
 */
export function restoreTarget(raw: string, basePath: string): string | null {
  // 只接受同源绝对路径，避免被构造成开放重定向
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  return base === '' ? raw : base + raw;
}

export function restoreHashRoute(): void {
  if (typeof window === 'undefined') return;
  const h = window.location.hash;
  if (!h.startsWith('#r=')) return;

  let decoded: string;
  try {
    decoded = decodeURIComponent(h.slice(3));
  } catch {
    return;   // 解不开就当普通首页，不要抛错挡住整个应用启动
  }

  const target = restoreTarget(decoded, BASE_PATH);
  if (target === null) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    return;
  }
  window.history.replaceState(null, '', target);
}

restoreHashRoute();
