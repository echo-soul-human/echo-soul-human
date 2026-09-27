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
export function restoreHashRoute(): void {
  if (typeof window === 'undefined') return;
  const h = window.location.hash;
  if (!h.startsWith('#r=')) return;

  let target: string;
  try {
    target = decodeURIComponent(h.slice(3));
  } catch {
    return;   // 解不开就当普通首页，不要抛错挡住整个应用启动
  }

  // 只接受同源相对路径，避免被构造成开放重定向
  if (!target.startsWith('/') || target.startsWith('//')) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    return;
  }

  window.history.replaceState(null, '', target);
}

restoreHashRoute();
