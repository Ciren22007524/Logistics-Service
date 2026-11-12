import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

// 後端直接提供建置好的前端：不需要資料庫（不打 /healthz）
describe('serving admin web from the backend', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'web-dist-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
    writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
    Object.assign(process.env, {
      APP_ENV: 'test',
      CREDENTIALS_ENC_KEYS: randomBytes(32).toString('base64'),
      WEB_DIST_DIR: dir,
      PUBLIC_BASE_URL: 'http://localhost:4310',
    });
    const { buildApp } = await import('../../src/api/app.js');
    app = await buildApp({ logger: false });
  });
  afterAll(async () => app?.close());

  it('首頁與前端路由回 index.html（不快取）', async () => {
    for (const url of ['/', '/shipments', '/shipments/abc?x=1', '/carrier-callbacks']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(200);
      expect(r.body).toContain('id="root"');
      expect(r.headers['cache-control']).toBe('no-cache');
    }
  });

  it('含 hash 的 assets 長期快取', async () => {
    const r = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toContain('immutable');
  });

  it('API 路徑與不存在的檔案不會被當成前端頁面', async () => {
    for (const url of ['/v1/nope', '/admin/api/nope', '/callbacks/X/y', '/assets/missing.js']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(404);
      expect(r.json().error.code).toBe('not_found');
    }
    expect((await app.inject({ method: 'POST', url: '/shipments' })).statusCode).toBe(404);
  });

  it('OIDC 回呼與後台網址預設跟著 PUBLIC_BASE_URL', async () => {
    const { config } = await import('../../src/config.js');
    expect(config().OIDC_REDIRECT_URI).toBe('http://localhost:4310/auth/callback');
    expect(config().ADMIN_WEB_URL).toBe('http://localhost:4310');
  });
});
