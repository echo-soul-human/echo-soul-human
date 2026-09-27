/**
 * spa-404.mjs — 生成 dist/404.html（GitHub Pages 的 SPA 回退页）
 *
 * 为什么需要它：Pages 不做 rewrite，刷新 /<base>/chat/<id> 直接 404。
 * 回退页把真实 path 编码进 hash 再跳回 index.html，由应用启动时
 * （web/src/lib/restoreHashRoute.ts）还原成正常 history 状态。
 *
 * 为什么不手写一个静态 404.html：base 是推导出来的（见 pages-base.mjs），
 * 静态文件只能猜「仓库名固定是路径第一段」。一旦确实是用户站仓库、
 * 显式设了 ECHOSOUL_BASE=/，那个猜测会把首段真实路由吃掉 —— /chat/7
 * 变成 /，刷新即丢会话。所以 base 必须在构建期注入。
 *
 * 为什么不改 hash 路由：URL 变丑，且分享链接的归因参数（?from=share:<id>）
 * 会一起被污染，而分享图落地页是本产品的主增长钩子。见 docs/分册-网页端.md §15。
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 回退页里要跑的那段 JS，单独导出成纯字符串 —— 这样 tests 能用
 * new Function 配一个假的 window.location 直接断言跳转结果，
 * 不必开浏览器。
 */
export function spa404Script(base) {
  // base 由仓库名推导，仍是外部输入；用 JSON.stringify 转义并剔掉
  // 能提前闭合 <script> 的字符。
  const safeBase = JSON.stringify(base).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `(function () {
  var BASE = ${safeBase};
  var l = window.location;
  var p = l.pathname;
  var rest = p.slice(0, BASE.length) === BASE ? p.slice(BASE.length) : '';
  if (rest && rest.charAt(0) !== '/') rest = '/' + rest;
  if (!rest) rest = '/';
  l.replace(BASE + '#r=' + encodeURIComponent(rest + l.search + l.hash));
})();`;
}

/** 完整回退页 HTML */
export function renderSpa404(base) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>星回</title>
  <meta name="robots" content="noindex" />
  <script>${spa404Script(base)}</script>
</head>
<body>
  <p>正在跳转…</p>
</body>
</html>
`;
}

/** 写进构建产物目录；返回写入路径 */
export function writeSpa404(outDir, base) {
  const target = join(outDir, '404.html');
  writeFileSync(target, renderSpa404(base), 'utf8');
  return target;
}
