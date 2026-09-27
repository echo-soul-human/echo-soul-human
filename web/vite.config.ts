import { defineConfig, type Plugin, type ResolvedConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { resolveBase } from '../scripts/pages-base.mjs';
import { writeSpa404 } from '../scripts/spa-404.mjs';

/**
 * base 与 PWA 的 id/scope/start_url 必须完全一致，否则资源 404、PWA 装不上。
 * 所以这里不能照抄 manifest.web.base_path —— 必须和 gen-manifest.mjs 共用
 * 同一个推导（ECHOSOUL_BASE > GITHUB_REPOSITORY > git remote > manifest > 默认），
 * 两边算出来的值才不会分叉；推导顺序也保证本地和 CI 得到同一个 base。
 */
const here = dirname(fileURLToPath(import.meta.url));
const rootManifest = JSON.parse(
  readFileSync(resolve(here, '../manifest.json'), 'utf8'),
);
const { base: BASE } = resolveBase({ manifestPath: 'manifest.json', cwd: resolve(here, '..') });

/**
 * GitHub Pages 不做 rewrite：刷新子路由会命中 404.html。
 * 这份回退页必须知道真实 base，所以只能在构建期生成，不能留成静态文件。
 */
let outDir: string = resolve(here, 'dist');

const spa404: Plugin = {
  name: 'echosoul:spa-404',
  apply: 'build',
  configResolved(cfg: ResolvedConfig) {
    outDir = cfg.build.outDir;
  },
  closeBundle() {
    writeSpa404(outDir, BASE);
  },
};

export default defineConfig({
  base: BASE,
  plugins: [react(), spa404],

  // 构建号注入 <meta name="x-build">，运行时轮询 /version 比对后提示刷新
  define: {
    __APP_BUILD__: JSON.stringify(rootManifest.web.build),
  },

  build: {
    target: 'es2021',
    cssTarget: 'chrome108',
    sourcemap: false,
    // 首屏 JS 预算 180KB gzip（docs/分册-网页端.md §10）。
    // 超预算不是"优化建议"，是 bug —— 靠 chunkSizeWarningLimit 提醒不够，
    // 上线前用 rollup-plugin-visualizer 核一次。
    chunkSizeWarningLimit: 420,
    rollupOptions: {
      output: {
        // SW 必须独立成 chunk，不能被打进主 bundle（否则注册不到）
        entryFileNames: 'assets/[name]-[hash].js',
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          // 重依赖一律异步：社区、分享图生成、富文本
          if (id.includes('html2canvas') || id.includes('satori')) return 'share';
          if (id.includes('framer-motion')) return 'motion';
          if (id.includes('@supabase')) return 'supabase';
          return 'vendor';
        },
      },
    },
  },

  worker: { format: 'es' },

  server: {
    host: true, // 手机连局域网真机验收用（docs/分册-网页端.md §5.7 矩阵）
    port: 5173,
  },

  preview: { host: true, port: 4173 },
});
