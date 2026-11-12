import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 選用的熱更新開發伺服器：平常後端直接提供 web/dist（npm run build:web），不需要開這個。
// 開這個時把 API 相關路徑轉給後端（4310），cookie 與 OIDC 回呼都在 5310
const api = process.env.LOGISTICS_API_URL ?? 'http://127.0.0.1:4310';
const proxied = ['/auth', '/admin/api', '/v1', '/cvs', '/callbacks', '/mock-carrier', '/healthz'];

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.LOGISTICS_WEB_PORT ?? 5310),
    strictPort: true,
    proxy: Object.fromEntries(proxied.map((p) => [p, { target: api, changeOrigin: false }])),
  },
  preview: { port: 5310 },
});
