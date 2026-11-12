/**
 * OIDC 與 OAuth 2.0 兩種登入協議的端到端測試（同一份設定、兩個 client、同一個回呼）。
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

describe.skipIf(!DB || !REDIS)('SSO: OIDC vs OAuth 2.0', () => {
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
      OIDC_CLIENT_ID: 'logistics-oidc',
      OIDC_CLIENT_SECRET: 'logistics-oidc-secret',
      OAUTH2_CLIENT_ID: 'logistics-oauth2',
      OAUTH2_CLIENT_SECRET: 'logistics-oauth2-secret',
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
  async function login(protocol: 'oidc' | 'oauth2', account = 'admin', returnTo = '/shipments') {
    const start = await app.inject({ method: 'GET', url: `/auth/login?protocol=${protocol}&return_to=${encodeURIComponent(returnTo)}` });
    expect(start.statusCode).toBe(302);
    const authUrl = new URL(start.headers.location as string);
    const txCookie = String(start.headers['set-cookie']).split(';')[0]!;
    const back = await authorizeInBrowser(authUrl.toString(), REDIRECT, account);
    const cb = await app.inject({ method: 'GET', url: `${back.pathname}${back.search}`, headers: { cookie: txCookie } });
    const setCookie = ([] as string[]).concat(cb.headers['set-cookie'] ?? []);
    const session = setCookie.map((c) => c.split(';')[0]!).find((c) => c.startsWith('ls_sid='));
    return { authUrl, callback: cb, session };
  }

  it('/auth/config 列出兩種協議', async () => {
    const r = (await app.inject({ method: 'GET', url: '/auth/config' })).json();
    expect(r.protocols).toEqual(['oidc', 'oauth2']);
  });

  it('OIDC：scope 含 openid、帶 nonce；身分來自 ID token', async () => {
    const { authUrl, callback, session } = await login('oidc');
    expect(authUrl.searchParams.get('client_id')).toBe('logistics-oidc');
    expect(authUrl.searchParams.get('scope')).toBe('openid email profile');
    expect(authUrl.searchParams.get('nonce')).toBeTruthy();
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(callback.headers.location).toBe(`${BASE}/shipments`);

    const me = (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: session! } })).json();
    expect(me).toMatchObject({ sub: 'admin', email: 'admin@example.com', roles: ['logistics_admin'], protocol: 'oidc' });

    const cmp = (await app.inject({ method: 'GET', url: '/auth/compare', headers: { cookie: session! } })).json();
    expect(cmp.oidc).toMatchObject({
      protocol: 'oidc',
      identity_source: 'id_token',
      received: { id_token: true, access_token: 'opaque', refresh_token: false },
    });
    expect(cmp.oidc.id_token_claims).toMatchObject({ iss: as.issuer, aud: 'logistics-oidc', sub: 'admin' });
    expect(cmp.oidc.id_token_claims.nonce).toBe(authUrl.searchParams.get('nonce'));
    expect(cmp.oidc.userinfo).toMatchObject({ sub: 'admin', roles: ['logistics_admin'] });
    // 回應裡不能有 token 原文
    expect(JSON.stringify(cmp)).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./);
  });

  it('OAuth 2.0：scope 不含 openid、沒有 nonce、沒有 ID token；身分來自 UserInfo', async () => {
    const { authUrl, session } = await login('oauth2');
    expect(authUrl.searchParams.get('client_id')).toBe('logistics-oauth2');
    expect(authUrl.searchParams.get('scope')).toBe('email profile');
    expect(authUrl.searchParams.has('nonce')).toBe(false);
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');

    const me = (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: session! } })).json();
    expect(me).toMatchObject({ sub: 'admin', email: 'admin@example.com', roles: ['logistics_admin'], protocol: 'oauth2' });

    const cmp = (await app.inject({ method: 'GET', url: '/auth/compare', headers: { cookie: session! } })).json();
    expect(cmp.current).toBe('oauth2');
    expect(cmp.oauth2).toMatchObject({
      protocol: 'oauth2',
      identity_source: 'userinfo',
      id_token_claims: null,
      received: { id_token: false },
      userinfo: { sub: 'admin', email: 'admin@example.com', roles: ['logistics_admin'] },
    });
    // 兩個 client 拿到同一個 sub（auth-service 的 subject_type 是 public）
    expect(cmp.oidc.userinfo.sub).toBe(cmp.oauth2.userinfo.sub);
  });

  it('兩種協議都套用相同的後台授權規則', async () => {
    for (const protocol of ['oidc', 'oauth2'] as const) {
      const { callback, session } = await login(protocol, 'nobody');
      expect(callback.headers.location).toBe(`${BASE}/login?error=forbidden`);
      expect(session).toBeUndefined();
    }
  });

  it('state 被竄改或交易過期：拒絕', async () => {
    const start = await app.inject({ method: 'GET', url: '/auth/login?protocol=oauth2' });
    const txCookie = String(start.headers['set-cookie']).split(';')[0]!;
    const back = await authorizeInBrowser(start.headers.location as string, REDIRECT, 'admin');
    back.searchParams.set('state', 'forged');
    const cb = await app.inject({ method: 'GET', url: `${back.pathname}${back.search}`, headers: { cookie: txCookie } });
    expect(cb.headers.location).toBe(`${BASE}/login?error=callback_failed`);
    // 交易是一次性的：同一個 cookie 再用一次
    const again = await app.inject({ method: 'GET', url: `${back.pathname}${back.search}`, headers: { cookie: txCookie } });
    expect(again.headers.location).toBe(`${BASE}/login?error=login_expired`);
  });

  it('未設定或未知的協議：400', async () => {
    expect((await app.inject({ method: 'GET', url: '/auth/login?protocol=saml' })).statusCode).toBe(400);
  });

  it('登出：兩種協議都撤銷 access token；全站登出只有 OIDC 帶 id_token_hint', async () => {
    const oidc = await login('oidc');
    const r1 = (await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: oidc.session! }, payload: { global: true } })).json();
    expect(r1.token_revoked).toBe(true);
    expect(r1.end_session_url).toContain('id_token_hint=');

    const oauth2 = await login('oauth2');
    const r2 = (await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: oauth2.session! }, payload: { global: true } })).json();
    expect(r2.token_revoked).toBe(true);
    expect(r2.end_session_url).not.toContain('id_token_hint=');
    expect(r2.end_session_url).toContain('client_id=logistics-oauth2');
    expect(as.revoked).toEqual(expect.arrayContaining(['logistics-oidc', 'logistics-oauth2']));
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: oauth2.session! } })).statusCode).toBe(401);
  });
});
