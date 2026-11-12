import * as client from 'openid-client';
import { config, type AuthProtocol } from '../../config.js';
import { logger } from '../../lib/logger.js';

/**
 * 串接 auth-service：同一個 issuer、同一份 discovery、同一個回呼網址，支援兩種協議（各用自己的 client）。
 *
 * | 項目       | OIDC（OIDC_CLIENT_*）                         | OAuth 2.0（OAUTH2_CLIENT_*）                 |
 * | ---------- | --------------------------------------------- | -------------------------------------------- |
 * | scope      | `openid email profile`                        | `email profile`（不含 openid）               |
 * | 授權流程   | Authorization Code + PKCE S256 + state        | 同左                                         |
 * | 防重放     | nonce（寫在 ID token 內）                     | 無 nonce，只靠 state + PKCE                  |
 * | 身分來源   | RS256 ID token（驗 iss / aud / exp / nonce）  | 用 access token 呼叫 UserInfo 取得 sub       |
 * | 角色       | UserInfo `roles`                              | UserInfo `roles`                             |
 * | 登出       | end_session_endpoint（可帶 id_token_hint）    | 撤銷 token；沒有 ID token 可做全站登出       |
 */

const configs = new Map<AuthProtocol, Promise<client.Configuration>>();

function clientCredentials(protocol: AuthProtocol): { id: string; secret: string; scope: string } {
  const c = config();
  return protocol === 'oidc'
    ? { id: c.OIDC_CLIENT_ID, secret: c.OIDC_CLIENT_SECRET, scope: c.OIDC_SCOPES }
    : { id: c.OAUTH2_CLIENT_ID, secret: c.OAUTH2_CLIENT_SECRET, scope: c.OAUTH2_SCOPES };
}

export function isProtocolEnabled(protocol: AuthProtocol): boolean {
  return config().authProtocols.includes(protocol);
}

export function protocolConfiguration(protocol: AuthProtocol): Promise<client.Configuration> {
  const c = config();
  if (!isProtocolEnabled(protocol))
    return Promise.reject(new Error(`${protocol} 未設定（${protocol === 'oidc' ? 'OIDC' : 'OAUTH2'}_CLIENT_ID / SECRET）`));
  let p = configs.get(protocol);
  if (!p) {
    const { id, secret } = clientCredentials(protocol);
    p = client
      .discovery(
        new URL(c.OIDC_ISSUER),
        id,
        protocol === 'oidc' ? { id_token_signed_response_alg: 'RS256' } : {},
        client.ClientSecretBasic(secret),
        // auth-service 本機開發只允許 localhost 走 http
        c.OIDC_ISSUER.startsWith('http://') ? { execute: [client.allowInsecureRequests] } : undefined,
      )
      .catch((err) => {
        configs.delete(protocol); // 下次重試 discovery
        logger.error({ err, issuer: c.OIDC_ISSUER, protocol }, 'authorization server discovery failed');
        throw err;
      });
    configs.set(protocol, p);
  }
  return p;
}

/** 測試用：清掉 discovery 快取 */
export function resetAuthConfigurations(): void {
  configs.clear();
}

export interface LoginTransaction {
  protocol: AuthProtocol;
  state: string;
  /** 只有 OIDC 有 nonce */
  nonce?: string;
  verifier: string;
  returnTo: string;
}

export async function startLogin(protocol: AuthProtocol, returnTo: string): Promise<{ url: string; tx: LoginTransaction }> {
  const cfg = await protocolConfiguration(protocol);
  const { scope } = clientCredentials(protocol);
  const verifier = client.randomPKCECodeVerifier();
  const tx: LoginTransaction = {
    protocol,
    state: client.randomState(),
    ...(protocol === 'oidc' ? { nonce: client.randomNonce() } : {}),
    verifier,
    returnTo,
  };
  const params: Record<string, string> = {
    redirect_uri: config().OIDC_REDIRECT_URI,
    scope: protocol === 'oauth2' ? withoutOpenid(scope) : scope,
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state: tx.state,
  };
  if (tx.nonce) params.nonce = tx.nonce;
  return { url: client.buildAuthorizationUrl(cfg, params).toString(), tx };
}

/** OAuth 2.0 模式絕不送 openid（送了就變成 OIDC） */
const withoutOpenid = (scope: string) =>
  scope
    .split(/\s+/)
    .filter((s) => s && s !== 'openid')
    .join(' ');

/** 兩種協議登入結果的比較資料（不含任何 token 原文） */
export interface LoginDetails {
  protocol: AuthProtocol;
  client_id: string;
  requested_scope: string;
  granted_scope: string | null;
  token_type: string | null;
  expires_in: number | null;
  received: {
    id_token: boolean;
    access_token: 'jwt' | 'opaque';
    refresh_token: boolean;
  };
  /** 身分（sub）從哪裡來 */
  identity_source: 'id_token' | 'userinfo';
  /** 這次登入實際做了哪些驗證 */
  checks: string[];
  id_token_claims: Record<string, unknown> | null;
  userinfo: Record<string, unknown>;
  logged_in_at: string;
}

export interface SsoUser {
  protocol: AuthProtocol;
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  roles: string[];
  idToken: string | undefined;
  /** 只存在後端 session，登出時撤銷 */
  accessToken: string;
  details: LoginDetails;
}

const looksLikeJwt = (t: string) => t.split('.').length === 3;

/** callback：比對 state、以 code + verifier 換 token；OIDC 驗 ID token，OAuth 2.0 改由 UserInfo 取身分 */
export async function finishLogin(callbackQuery: string, tx: LoginTransaction): Promise<SsoUser> {
  const cfg = await protocolConfiguration(tx.protocol);
  const { id, scope } = clientCredentials(tx.protocol);
  // 必須用與授權請求完全相同的 redirect_uri
  const currentUrl = new URL(config().OIDC_REDIRECT_URI);
  currentUrl.search = callbackQuery;
  const tokens = await client.authorizationCodeGrant(cfg, currentUrl, {
    pkceCodeVerifier: tx.verifier,
    expectedState: tx.state,
    ...(tx.protocol === 'oidc' ? { expectedNonce: tx.nonce, idTokenExpected: true } : { idTokenExpected: false }),
  });

  const checks = ['state 一致', 'PKCE S256 verifier（由授權伺服器驗證）', 'client_secret_basic 認證'];
  let sub: string;
  let idClaims: Record<string, unknown> | null = null;
  if (tx.protocol === 'oidc') {
    const claims = tokens.claims();
    if (!claims) throw new Error('missing id_token');
    sub = claims.sub;
    idClaims = { ...claims };
    checks.push('ID token RS256 簽章（JWKS）', 'iss = issuer', `aud = ${id}`, 'exp / iat', 'nonce 一致');
  } else {
    // 純 OAuth 2.0：token 回應不應該有 ID token；身分只能靠 UserInfo
    if (tokens.id_token) logger.warn({ protocol: 'oauth2' }, 'unexpected id_token in OAuth 2.0 response');
    sub = '';
  }

  const info = await client.fetchUserInfo(cfg, tokens.access_token, sub || client.skipSubjectCheck);
  if (tx.protocol === 'oidc') checks.push('UserInfo sub 與 ID token sub 一致');
  else {
    if (typeof info.sub !== 'string' || !info.sub) throw new Error('userinfo missing sub');
    sub = info.sub;
    checks.push('UserInfo 以 Bearer access token 取得（TLS 連線到 issuer 的 userinfo_endpoint）');
  }

  const roles = Array.isArray(info.roles) ? info.roles.filter((r): r is string => typeof r === 'string') : [];
  const user: SsoUser = {
    protocol: tx.protocol,
    sub,
    email: (info.email as string | undefined) ?? (idClaims?.email as string | undefined) ?? null,
    emailVerified: Boolean(info.email_verified ?? idClaims?.email_verified),
    name: (info.name as string | undefined) ?? null,
    roles,
    idToken: tokens.id_token,
    accessToken: tokens.access_token,
    details: {
      protocol: tx.protocol,
      client_id: id,
      requested_scope: tx.protocol === 'oauth2' ? withoutOpenid(scope) : scope,
      granted_scope: tokens.scope ?? null,
      token_type: tokens.token_type ?? null,
      expires_in: tokens.expiresIn() ?? null,
      received: {
        id_token: Boolean(tokens.id_token),
        access_token: looksLikeJwt(tokens.access_token) ? 'jwt' : 'opaque',
        refresh_token: Boolean(tokens.refresh_token),
      },
      identity_source: tx.protocol === 'oidc' ? 'id_token' : 'userinfo',
      checks,
      id_token_claims: idClaims,
      userinfo: { ...info },
      logged_in_at: new Date().toISOString(),
    },
  };
  return user;
}

/** 撤銷 access token（兩種協議都做，盡力而為；失敗只記 log） */
export async function revokeAccessToken(protocol: AuthProtocol, accessToken: string | undefined): Promise<boolean> {
  if (!accessToken) return false;
  try {
    const cfg = await protocolConfiguration(protocol);
    if (!cfg.serverMetadata().revocation_endpoint) return false;
    await client.tokenRevocation(cfg, accessToken, { token_type_hint: 'access_token' });
    return true;
  } catch (err) {
    logger.warn({ err, protocol }, 'token revocation failed');
    return false;
  }
}

/** 全站登出網址（auth-service end_session_endpoint）；只有 OIDC 有 ID token 可以帶 */
export async function endSessionUrl(protocol: AuthProtocol, idToken: string | undefined): Promise<string | null> {
  try {
    const cfg = await protocolConfiguration(protocol);
    if (!cfg.serverMetadata().end_session_endpoint) return null;
    const params: Record<string, string> = { client_id: clientCredentials(protocol).id };
    if (idToken) params.id_token_hint = idToken;
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
