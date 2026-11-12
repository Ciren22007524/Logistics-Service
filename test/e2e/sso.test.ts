/**
 * OAuth 2.0 登入端到端測試（oauth2 分支）：對 oidc-provider（設定比照 auth-service）實際走完授權碼流程。
 * 需要 Redis 與 PostgreSQL（session 與稽核紀錄），未設定 TEST_DATABASE_URL / TEST_REDIS_URL 時跳過。
 */
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authorizeInBrowser, startFakeAuthService, type FakeAuthService } from './fake-auth-service.js';

const DB = process.env.TEST_DATABASE_URL;
const REDIS = process.env.TEST_REDIS_URL;
const BASE = 'http://localhost:4310';
const REDIRECT = `${BASE}/auth/callback`;

describe.skipIf(!DB || !REDIS)('OAuth 2.0 login', () => {
  let app: FastifyInstance;
  let as: FakeAuthService;
  let closeAll: () => Promise<void>;

  beforeAll(async () => {
    as = await startFakeAuthService(REDIRECT);
    Object.assign(process.env, {
      APP_ENV: 'test',
      DATABASE_URL: DB,
      REDIS_URL: REDIS,
      CREDENTIALS_ENC_KEYS: randomBytes(32).toString('base64'),
      PUBLIC_BASE_URL: BASE,
      OIDC_ISSUER: as.issuer,
      OAUTH2_CLIENT_ID: 'logistics-oauth2',
      OAUTH2_CLIENT_SECRET: 'logistics-oauth2-secret',
      // 就算設定裡誤寫 openid 也不能送出
      OAUTH2_SCOPES: 'openid email profile',
      ADMIN_ROLES: 'logistics_admin',
      AUTH_DEV_BYPASS: 'false',
      RUN_WORKER: 'false',
    });
    const pool = (await import('../../src/infra/db/pool.js')).db();
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await (await import('../../src/infra/db/migrate.js')).migrate(pool, resolve(import.meta.dirname, '../../migrations'));
    app = await (await import('../../src/api/app.js')).buildApp({ logger: false });
    closeAll = async () => {
      await app.close();
      await (await import('../../src/infra/queue/queues.js')).closeQueues();
      await (await import('../../src/infra/redis.js')).closeRedis();
      await (await import('../../src/infra/db/pool.js')).closeDb();
    };
  });

  afterAll(async () => {
    await closeAll?.();
    await as?.close();
  });

  /** 完整登入：/auth/login → 授權伺服器 → /auth/callback，回傳 session cookie 與授權請求參數 */
  async function login(account = 'admin', returnTo = '/shipments') {
    const start = await app.inject({ method: 'GET', url: `/auth/login?return_to=${encodeURIComponent(returnTo)}` });
    expect(start.statusCode).toBe(302);
    const authUrl = new URL(start.headers.location as string);
    const txCookie = String(start.headers['set-cookie']).split(';')[0]!;
    const back = await authorizeInBrowser(authUrl.toString(), REDIRECT, account);
    const cb = await app.inject({ method: 'GET', url: `${back.pathname}${back.search}`, headers: { cookie: txCookie } });
    const setCookie = ([] as string[]).concat(cb.headers['set-cookie'] ?? []);
    const session = setCookie.map((c) => c.split(';')[0]!).find((c) => c.startsWith('ls_sid='));
    return { authUrl, callback: cb, session };
  }

  it('/auth/config：OAuth 2.0 已設定', async () => {
    expect((await app.inject({ method: 'GET', url: '/auth/config' })).json()).toMatchObject({
      protocol: 'oauth2',
      configured: true,
      issuer: as.issuer,
    });
  });

  it('授權請求：不含 openid、沒有 nonce，帶 PKCE S256 與 state', async () => {
    const { authUrl, callback, session } = await login();
    expect(authUrl.searchParams.get('client_id')).toBe('logistics-oauth2');
    expect(authUrl.searchParams.get('scope')).toBe('email profile');
    expect(authUrl.searchParams.has('nonce')).toBe(false);
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('state')).toBeTruthy();
    expect(authUrl.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(callback.headers.location).toBe(`${BASE}/shipments`);
    expect(session).toBeTruthy();
  });

  it('身分與角色來自 UserInfo', async () => {
    const { session } = await login();
    const me = (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: session! } })).json();
    expect(me).toMatchObject({ sub: 'admin', email: 'admin@example.com', name: '測試管理者', roles: ['logistics_admin'] });
    // 後台 API 可用
    expect((await app.inject({ method: 'GET', url: '/admin/api/dashboard', headers: { cookie: session! } })).statusCode).toBe(200);
  });

  it('沒有後台角色：forbidden，不建立 session', async () => {
    const { callback, session } = await login('nobody');
    expect(callback.headers.location).toBe(`${BASE}/login?error=forbidden`);
    expect(session).toBeUndefined();
  });

  it('state 被竄改：拒絕；交易一次性', async () => {
    const start = await app.inject({ method: 'GET', url: '/auth/login' });
    const txCookie = String(start.headers['set-cookie']).split(';')[0]!;
    const back = await authorizeInBrowser(start.headers.location as string, REDIRECT, 'admin');
    back.searchParams.set('state', 'forged');
    const cb = await app.inject({ method: 'GET', url: `${back.pathname}${back.search}`, headers: { cookie: txCookie } });
    expect(cb.headers.location).toBe(`${BASE}/login?error=callback_failed`);
    const again = await app.inject({ method: 'GET', url: `${back.pathname}${back.search}`, headers: { cookie: txCookie } });
    expect(again.headers.location).toBe(`${BASE}/login?error=login_expired`);
  });

  it('登出：撤銷 access token；全站登出只帶 client_id', async () => {
    const { session } = await login();
    const r = (await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: session! }, payload: { global: true } })).json();
    expect(r.token_revoked).toBe(true);
    expect(r.end_session_url).toContain('client_id=logistics-oauth2');
    expect(r.end_session_url).not.toContain('id_token_hint=');
    expect(as.revoked).toContain('logistics-oauth2');
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: session! } })).statusCode).toBe(401);
  });
});
