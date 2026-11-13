import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/** oauth2 分支：登入只能是純 OAuth 2.0，不能混入任何 OIDC 的東西 */
describe('pure OAuth 2.0 login', () => {
  let mod: typeof import('../../src/api/auth/oauth2.js');

  beforeAll(async () => {
    Object.assign(process.env, {
      APP_ENV: 'test',
      CREDENTIALS_ENC_KEYS: randomBytes(32).toString('base64'),
      PUBLIC_BASE_URL: 'http://localhost:4310',
      OIDC_ISSUER: 'https://auth.example.com',
      OAUTH2_CLIENT_ID: 'my client',
      OAUTH2_CLIENT_SECRET: 's3cr:et+/',
      OAUTH2_SCOPES: 'openid email profile',
    });
    mod = await import('../../src/api/auth/oauth2.js');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('登入相關程式只用 oauth4webapi 的 OAuth 2.0 功能，不用 OIDC 函式庫或 OIDC 功能', () => {
    const dir = join(import.meta.dirname, '../../src/api/auth');
    for (const f of readdirSync(dir)) {
      // 只看程式碼，註解裡說明「不做什麼」不算
      const src = readFileSync(join(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      // OIDC 函式庫（oauth4webapi 同時支援兩種協議，允許使用，但只能用 OAuth 2.0 的函式）
      expect(src, f).not.toMatch(/from ['"](openid-client|oidc-provider|jose)['"]/);
      // oauth4webapi 的 OIDC 功能：UserInfo、Discovery、ID token 驗證、nonce
      expect(src, f).not.toMatch(
        /\b(userInfoRequest|processUserInfoResponse|discoveryRequest|processDiscoveryResponse|getValidatedIdTokenClaims|validateApplicationLevelSignature|expectedNonce|generateRandomNonce|requireIdToken)\b/,
      );
      expect(src, f).not.toMatch(/openid-configuration|end_session|id_token_hint|nonce=/);
    }
  });

  it('授權網址：沒有 openid、沒有 nonce；PKCE S256、state、response_type=code', async () => {
    const { url, tx } = await mod.startLogin('/');
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://auth.example.com/oidc/auth');
    expect(u.searchParams.get('scope')).toBe('email profile');
    expect(u.searchParams.has('nonce')).toBe(false);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('state')).toBe(tx.state);
    expect(tx.verifier).toHaveLength(43);
  });

  const tx = { state: 'st', verifier: 'v'.repeat(43), returnTo: '/' };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  function stubServer(tokenBody: Record<string, unknown>) {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith('/oidc/token')) return json(tokenBody);
        if (url.endsWith('/oidc/userinfo')) return json({ sub: 'usr_1', email: 'a@b.c', email_verified: true, roles: ['r'] });
        return json({}, 404);
      }),
    );
    return calls;
  }

  it('正常：token（client_secret_basic、code_verifier）→ Bearer 使用者資料', async () => {
    const calls = stubServer({ access_token: 'at', token_type: 'Bearer', expires_in: 900 });
    const user = await mod.finishLogin('?code=c&state=st&iss=https%3A%2F%2Fauth.example.com', tx);
    expect(user).toMatchObject({ sub: 'usr_1', email: 'a@b.c', emailVerified: true, roles: ['r'], accessToken: 'at' });
    const token = calls[0]!;
    // RFC 6749 §2.3.1：先 form-urlencode 再 Base64
    expect(new Headers(token.init!.headers).get('authorization')).toBe(
      `Basic ${Buffer.from('my+client:s3cr%3Aet%2B%2F').toString('base64')}`,
    );
    const form = new URLSearchParams(String(token.init!.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'authorization_code',
      code: 'c',
      redirect_uri: 'http://localhost:4310/auth/callback',
      code_verifier: tx.verifier,
    });
    expect(new Headers(calls[1]!.init!.headers).get('authorization')).toBe('Bearer at');
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/oidc/token', '/oidc/userinfo']);
  });

  it('收到 ID token：拒絕（代表跑成 OIDC）', async () => {
    stubServer({ access_token: 'at', token_type: 'Bearer', id_token: 'x.y.z' });
    await expect(mod.finishLogin('?code=c&state=st', tx)).rejects.toThrow(/id_token/);
  });

  it('state 不符、iss 不符（RFC 9207）、token_type 不是 Bearer：拒絕', async () => {
    stubServer({ access_token: 'at', token_type: 'mac' });
    await expect(mod.finishLogin('?code=c&state=evil', tx)).rejects.toThrow(/state/);
    await expect(mod.finishLogin('?code=c&state=st&iss=https%3A%2F%2Fevil.example', tx)).rejects.toThrow(/iss/);
    await expect(mod.finishLogin('?code=c&state=st', tx)).rejects.toThrow(/token_type/);
  });
});
