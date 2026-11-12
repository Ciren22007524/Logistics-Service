import * as client from 'openid-client';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';

/**
 * 串接 auth-service：純 OAuth 2.0（oauth2 分支；main 分支是 OIDC 版本，其餘程式相同）。
 *
 * - Authorization Code + PKCE S256 + state，client_secret_basic
 * - scope 不含 `openid`（預設 `email profile`）：不發 ID token、不用 nonce
 * - 身分：用 access token 呼叫 discovery 的 `userinfo_endpoint`（auth-service `/oidc/userinfo`）取得 sub、email、roles
 * - 登出：撤銷 access token；全站登出只能帶 client_id（沒有 ID token 可當 id_token_hint）
 *
 * 端點仍由 auth-service 的 discovery 取得（與 main 分支共用 OIDC_ISSUER、回呼網址設定）。
 */
let configPromise: Promise<client.Configuration> | undefined;

export function oauth2Configuration(): Promise<client.Configuration> {
  const c = config();
  if (!c.oauth2Enabled) return Promise.reject(new Error('OAuth 2.0 未設定（OAUTH2_CLIENT_ID / OAUTH2_CLIENT_SECRET）'));
  configPromise ??= client
    .discovery(
      new URL(c.OIDC_ISSUER),
      c.OAUTH2_CLIENT_ID,
      {},
      client.ClientSecretBasic(c.OAUTH2_CLIENT_SECRET),
      // auth-service 本機開發只允許 localhost 走 http
      c.OIDC_ISSUER.startsWith('http://') ? { execute: [client.allowInsecureRequests] } : undefined,
    )
    .catch((err) => {
      configPromise = undefined; // 下次重試 discovery
      logger.error({ err, issuer: c.OIDC_ISSUER }, 'authorization server discovery failed');
      throw err;
    });
  return configPromise;
}

/** 純 OAuth 2.0 絕不送 openid（送了就變成 OIDC） */
export const oauth2Scope = () =>
  config()
    .OAUTH2_SCOPES.split(/\s+/)
    .filter((s) => s && s !== 'openid')
    .join(' ');

export interface LoginTransaction {
  state: string;
  verifier: string;
  returnTo: string;
}

export async function startLogin(returnTo: string): Promise<{ url: string; tx: LoginTransaction }> {
  const cfg = await oauth2Configuration();
  const verifier = client.randomPKCECodeVerifier();
  const tx: LoginTransaction = { state: client.randomState(), verifier, returnTo };
  const url = client.buildAuthorizationUrl(cfg, {
    redirect_uri: config().OIDC_REDIRECT_URI,
    scope: oauth2Scope(),
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state: tx.state,
  });
  return { url: url.toString(), tx };
}

export interface SsoUser {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  roles: string[];
  /** 只存在後端 session，登出時撤銷 */
  accessToken: string;
}

/** callback：比對 state、以 code + verifier 換 access token，再用 UserInfo 取身分 */
export async function finishLogin(callbackQuery: string, tx: LoginTransaction): Promise<SsoUser> {
  const cfg = await oauth2Configuration();
  // 必須用與授權請求完全相同的 redirect_uri
  const currentUrl = new URL(config().OIDC_REDIRECT_URI);
  currentUrl.search = callbackQuery;
  const tokens = await client.authorizationCodeGrant(cfg, currentUrl, {
    pkceCodeVerifier: tx.verifier,
    expectedState: tx.state,
    idTokenExpected: false,
  });
  // 純 OAuth 2.0 不應該拿到 ID token；拿到代表 client 設定跑成 OIDC，記下來方便排查
  if (tokens.id_token) logger.warn('unexpected id_token in OAuth 2.0 token response');

  // 沒有 ID token 可以比對 sub，身分以 UserInfo 回傳為準
  const info = await client.fetchUserInfo(cfg, tokens.access_token, client.skipSubjectCheck);
  if (typeof info.sub !== 'string' || !info.sub) throw new Error('userinfo missing sub');
  const roles = Array.isArray(info.roles) ? info.roles.filter((r): r is string => typeof r === 'string') : [];
  return {
    sub: info.sub,
    email: (info.email as string | undefined) ?? null,
    emailVerified: Boolean(info.email_verified),
    name: (info.name as string | undefined) ?? null,
    roles,
    accessToken: tokens.access_token,
  };
}

/** 撤銷 access token（盡力而為；失敗只記 log） */
export async function revokeAccessToken(accessToken: string | undefined): Promise<boolean> {
  if (!accessToken) return false;
  try {
    const cfg = await oauth2Configuration();
    if (!cfg.serverMetadata().revocation_endpoint) return false;
    await client.tokenRevocation(cfg, accessToken, { token_type_hint: 'access_token' });
    return true;
  } catch (err) {
    logger.warn({ err }, 'token revocation failed');
    return false;
  }
}

/** 全站登出網址（auth-service end_session_endpoint）；OAuth 2.0 沒有 ID token，只帶 client_id */
export async function endSessionUrl(): Promise<string | null> {
  try {
    const cfg = await oauth2Configuration();
    if (!cfg.serverMetadata().end_session_endpoint) return null;
    const params: Record<string, string> = { client_id: config().OAUTH2_CLIENT_ID };
    if (config().OIDC_POST_LOGOUT_REDIRECT_URI) params.post_logout_redirect_uri = config().OIDC_POST_LOGOUT_REDIRECT_URI!;
    return client.buildEndSessionUrl(cfg, params).toString();
  } catch {
    return null;
  }
}

/** 後台授權：email 白名單或 roles 任一符合；兩者都沒設時只有非 production 允許所有登入者 */
export function isAdminAllowed(user: Pick<SsoUser, 'email' | 'emailVerified' | 'roles'>): boolean {
  const c = config();
  const emails = c.ADMIN_EMAILS.map((e) => e.toLowerCase());
  const roles = c.ADMIN_ROLES;
  if (emails.length === 0 && roles.length === 0) return !c.isProduction;
  if (user.email && user.emailVerified && emails.includes(user.email.toLowerCase())) return true;
  return user.roles.some((r) => roles.includes(r));
}
