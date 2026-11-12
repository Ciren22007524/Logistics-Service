import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 開發時把 API 相關路徑轉給 Logistics API（4310），瀏覽器只看到同一個來源 → cookie 與 OIDC 回呼都在 5310
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
