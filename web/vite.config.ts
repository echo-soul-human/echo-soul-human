import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * base 必须等于 manifest.json 的 web.base_path。
 * 三处路径（manifest id / scope / base）不一致会导致 PWA 安装状态丢失，
 * gen-manifest.mjs 末尾有一致性自检兜底，这里再声明一次来源。
 */
const here = dirname(fileURLToPath(import.meta.url));
const rootManifest = JSON.parse(
  readFileSync(resolve(here, '../manifest.json'), 'utf8'),
);

export default defineConfig({
  base: rootManifest.web.base_path,
  plugins: [react()],

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
