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
  /**
   * 构建产物的本地验证（§10.6，Q-24 定案：前后端分离）。
   *
   * 后端只管 `/api/*`，`dist/client` 由静态托管发出——生产上那一层是 nginx，
   * 本地就是这里。这不是「另一个 dev server」：`vite preview` 起的是
   * **构建产物**，走的是与线上同一份 js/css。
   *
   * 端口刻意与 dev（5273）错开，否则两者会互相顶掉，
   * 而现象是「我明明改了代码，页面没变」——因为你看的是构建产物。
   *
   * 这里没有 `server` 那条 `.ts/.tsx` bypass：产物里不存在 `/api/*.ts` 的模块请求，
   * 加上反而会让一个真实的 API 路径在某天被误判放行。
   *
   * **这里刻意不配任何「关缓冲」的东西。** 曾经写过一段 `configure` 钩子给 SSE 响应
   * 打 `x-accel-buffering: no`，看着像是在防 §10.6 说的那个缓冲问题。
   * 按「去掉它，看有没有区别」反证过一遍：带与不带，34 条 trace / 39 条 delta
   * 与 6 次明显间隔完全一致——vite 的代理本来就是 pipe，而 `x-accel-buffering`
   * 是写给 nginx 看的指令，浏览器不认。那段钩子一点作用没有。
   *
   * 所以 §10.6 那条 `proxy_buffering off` 的约束**只对生产的 nginx 成立**，
   * 本地这一层无法替它把关——别让这里的绿色给人「缓冲问题已经验过了」的错觉。
   */
  preview: {
    port: 5274,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3311',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: r('./dist/client'),
    emptyOutDir: true,
  },
});
