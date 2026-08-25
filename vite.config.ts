import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: r('./src/client'),
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': r('./src/shared'),
      '@client': r('./src/client'),
    },
  },
  server: {
    port: 5273,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3311',
        changeOrigin: true,
        // src/client/api/ 下的前端薄客户端模块在 dev 下的 URL 也是 /api/*.ts，
        // 会被这条代理截走。真正的 API 调用都不带 .ts 扩展名，
        // 因此让模块请求（.ts/.tsx）回到 Vite 自身的服务，其余才代理给后端。
        bypass: (req) =>
          req.url !== undefined && /\.(tsx?)(\?|$)/.test(req.url) ? req.url : undefined,
      },
    },
  },
  build: {
    outDir: r('./dist/client'),
    emptyOutDir: true,
  },
});
