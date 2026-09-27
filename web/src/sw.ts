/// <reference lib="webworker" />
/**
 * sw.ts — Service Worker
 *
 * ★ 职责被严格限定为两件事：
 *   1. 接收 Web Push 并显示通知
 *   2. 收到 SKIP_WAITING 消息时提示刷新（不自动刷新，避免弄丢用户正在写的长消息）
 *
 * 明确不做：fetch 拦截、caches.open、precache、离线兜底页。
 * 原因见 docs/分册-网页端.md §6.2 —— GitHub Pages 边缘刷新延迟会造成
 * 「旧 UI 配新接口」，且本项目所有业务数据都是动态的。
 * 断网不可用是**接受的取舍**，不是待修缺陷。
 *
 * scripts/audit-sw.mjs 会在 CI 里强制这条，缓存一出现就构建失败。
 */
declare const self: ServiceWorkerGlobalScope;

type PushPayload = {
  title?: string;
  body?: string;
  tag?: string;
  url?: string;
  image?: string;
  count?: number;
};

function parse(data: string | null): PushPayload {
  if (!data) return {};
  try { return JSON.parse(data) as PushPayload; } catch { return {}; }
}

self.addEventListener('push', (event: PushEvent) => {
  const p = parse(event.data?.text() ?? null);

  // 服务端已按角色合并（V5-9：同角色连发 5 条只出 1 条通知）。
  // tag 是二次保险：即使多条漏过合并，同 tag 也只保留一条。
  event.waitUntil(
    self.registration.showNotification(p.title ?? '有新消息', {
      body: p.body ?? '',
      tag: p.tag ?? 'renji-message',
      icon: 'icons/icon-192.png',
      badge: 'icons/maskable-192.png',
      // NotificationOptions 类型里没有 image（非标准字段），需要图片走 ServiceWorkerNotificationExtend 另说

      data: { url: p.url ?? '/' },
      silent: false,
    }),
  );
});

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const target = (event.notification.data?.url as string | undefined) ?? '/';

  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

    // 优先聚焦已有窗口并让它跳转，而不是新开一个
    for (const c of all) {
      if ('focus' in c) {
        c.postMessage({ type: 'NAVIGATE', url: target });
        return c.focus();
      }
    }
    await self.clients.openWindow(target);
  })());
});

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  // 只接受刷新提示，不做任何资源缓存
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(self.clients.claim());
});

export {};
