/**
 * 測試用授權伺服器：用 auth-service 同一套 oidc-provider，設定比照 auth-service：
 * - Authorization Code + PKCE S256（必要）、client_secret_basic、ID token RS256
 * - 兩個 client：OIDC 用與 OAuth 2.0 用（同一個回呼網址）
 * - profile scope 回傳 roles；純 OAuth 2.0 token（無 openid）也能呼叫 UserInfo（比照 auth-service 的 userinfo.ts）
 * - 開 token 撤銷、RP-initiated logout
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Provider from 'oidc-provider';

export interface FakeAuthService {
  issuer: string;
  close: () => Promise<void>;
  revoked: string[];
}

export const ACCOUNTS: Record<string, { email: string; name: string; roles: string[] }> = {
  admin: { email: 'admin@example.com', name: '測試管理者', roles: ['logistics_admin'] },
  nobody: { email: 'nobody@example.com', name: '一般使用者', roles: [] },
};

export async function startFakeAuthService(redirectUri: string): Promise<FakeAuthService> {
  const revoked: string[] = [];
  // 先拿到 port 才能決定 issuer
  const { createServer } = await import('node:http');
  const server: Server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const issuer = `http://localhost:${(server.address() as AddressInfo).port}`;

  const client = (id: string, scope: string) => ({
    client_id: id,
    client_secret: `${id}-secret`,
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: 'client_secret_basic' as const,
    grant_types: ['authorization_code'],
    response_types: ['code' as const],
    scope,
  });

  const provider = new Provider(issuer, {
    clients: [client('logistics-oidc', 'openid email profile'), client('logistics-oauth2', 'email profile')],
    scopes: ['openid', 'email', 'profile'],
    pkce: { required: () => true },
    claims: { openid: ['sub'], email: ['email', 'email_verified'], profile: ['name', 'roles'] },
    findAccount: async (_ctx, sub) => {
      const a = ACCOUNTS[sub];
      if (!a) return undefined;
      return {
        accountId: sub,
        claims: async () => ({ sub, email: a.email, email_verified: true, name: a.name, roles: a.roles }),
      };
    },
    features: {
      devInteractions: { enabled: true },
      revocation: { enabled: true },
      rpInitiatedLogout: { enabled: true },
    },
    // 只發不透明 access token（與 auth-service 不帶 resource 時相同）
    ttl: { AccessToken: 900 },
  });
  provider.on('server_error', (_ctx, err) => console.error('[fake-as]', err));
  // 撤銷成功時 access token 會被刪除
  provider.on('access_token.destroyed', (token: { clientId?: string }) => revoked.push(String(token.clientId)));

  // 純 OAuth 2.0 的 UserInfo：token 沒有 openid scope 時自己回 claims（auth-service userinfo.ts 的簡化版）
  provider.use(async (ctx, next) => {
    if (ctx.path !== '/me' || ctx.method !== 'GET') return next();
    const m = /^Bearer (.+)$/.exec(ctx.get('authorization'));
    const token = m ? await provider.AccessToken.find(m[1]!) : undefined;
    if (!token || !token.isValid) {
      ctx.status = 401;
      ctx.body = { error: 'invalid_token' };
      return;
    }
    if (token.scopes.has('openid')) return next();
    const a = ACCOUNTS[token.accountId!]!;
    const body: Record<string, unknown> = { sub: token.accountId };
    if (token.scopes.has('email')) Object.assign(body, { email: a.email, email_verified: true });
    if (token.scopes.has('profile')) Object.assign(body, { name: a.name, roles: a.roles });
    ctx.body = body;
  });

  server.on('request', provider.callback());
  return {
    issuer,
    revoked,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/**
 * 模擬瀏覽器走完授權頁：跟著轉址、送出 devInteractions 的登入與同意表單，
 * 直到被導回 redirectUri，回傳那個網址（含 code / state）。
 */
export async function authorizeInBrowser(authUrl: string, redirectUri: string, login: string): Promise<URL> {
  const jar = new Map<string, string>();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const remember = (res: Response) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      jar.set(pair!.slice(0, i), pair!.slice(i + 1));
    }
  };
  let url = authUrl;
  let init: RequestInit = {};
  for (let step = 0; step < 15; step++) {
    if (url.startsWith(redirectUri)) return new URL(url);
    const res = await fetch(url, { ...init, redirect: 'manual', headers: { ...(init.headers ?? {}), cookie: cookieHeader() } });
    remember(res);
    const loc = res.headers.get('location');
    if (loc) {
      url = new URL(loc, url).toString();
      init = {};
      continue;
    }
    const html = await res.text();
    const form = /<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i.exec(html);
    if (!form) throw new Error(`no form at ${url}: ${res.status} ${html.slice(0, 200)}`);
    const fields = new URLSearchParams();
    for (const [tag] of form[2]!.matchAll(/<input[^>]*>/gi)) {
      const name = /name="([^"]+)"/.exec(tag)?.[1];
      if (name) fields.set(name, /value="([^"]*)"/.exec(tag)?.[1] ?? '');
    }
    if (fields.has('login')) fields.set('login', login);
    if (fields.has('password')) fields.set('password', 'any');
    url = new URL(form[1]!.replace(/&amp;/g, '&'), url).toString();
    init = { method: 'POST', body: fields.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } };
  }
  throw new Error('authorization did not finish');
}
