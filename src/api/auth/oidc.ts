import * as client from 'openid-client';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';

/**
 * auth-service（標準 OIDC）設定：
 * - Authorization Code + PKCE S256，client_secret_basic
 * - ID token RS256：用 auth-service 的 JWKS 公鑰驗簽章（enableNonRepudiationChecks），
 *   並驗 issuer / audience / exp / iat / nonce（openid-client 處理）
 * - 角色從 UserInfo 的 `roles` 取得（需 profile scope）
 */
let configPromise: Promise<client.Configuration> | undefined;

export function oidcConfiguration(): Promise<client.Configuration> {
  const c = config();
  if (!c.oidcEnabled) return Promise.reject(new Error('OIDC 未設定（OIDC_CLIENT_ID / OIDC_CLIENT_SECRET）'));
  configPromise ??= client
    .discovery(
      new URL(c.OIDC_ISSUER),
      c.OIDC_CLIENT_ID,
      { id_token_signed_response_alg: 'RS256' },
      client.ClientSecretBasic(c.OIDC_CLIENT_SECRET),
      {
        execute: [
          // openid-client v6 預設不驗 ID token 簽章（只靠 HTTPS 確認來源），要明確開啟才會用 JWKS 公鑰驗。
          // auth-service 串接文件要求驗簽章；本機開發的 http issuer 沒有 HTTPS 保護，更需要。
          // 公鑰在第一次登入時下載，記憶體快取 5 分鐘；遇到不認得的 kid 會重新下載（金鑰輪替）。
          client.enableNonRepudiationChecks,
          // auth-service 本機開發只允許 localhost 走 http
          ...(c.OIDC_ISSUER.startsWith('http://') ? [client.allowInsecureRequests] : []),
        ],
      },
    )
    .catch((err) => {
      configPromise = undefined; // 下次重試 discovery
      logger.error({ err, issuer: c.OIDC_ISSUER }, 'OIDC discovery failed');
      throw err;
    });
  return configPromise;
}

export interface LoginTransaction {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
}

export async function startLogin(returnTo: string): Promise<{ url: string; tx: LoginTransaction }> {
  const cfg = await oidcConfiguration();
  const verifier = client.randomPKCECodeVerifier();
  const tx: LoginTransaction = {
    state: client.randomState(),
    nonce: client.randomNonce(),
    verifier,
    returnTo,
  };
  const url = client.buildAuthorizationUrl(cfg, {
    redirect_uri: config().OIDC_REDIRECT_URI,
    scope: config().OIDC_SCOPES,
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state: tx.state,
    nonce: tx.nonce,
  });
  return { url: url.toString(), tx };
}

export interface OidcUser {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  roles: string[];
  idToken: string | undefined;
  /** 只存在後端 session（Redis），登出時撤銷 */
  accessToken: string;
}

/** callback：比對 state、以 code + verifier 換 token、驗 ID token、取 UserInfo */
export async function finishLogin(callbackQuery: string, tx: LoginTransaction): Promise<OidcUser> {
  const cfg = await oidcConfiguration();
  // 必須用與授權請求完全相同的 redirect_uri
  const currentUrl = new URL(config().OIDC_REDIRECT_URI);
  currentUrl.search = callbackQuery;
  const tokens = await client.authorizationCodeGrant(cfg, currentUrl, {
    pkceCodeVerifier: tx.verifier,
    expectedState: tx.state,
    expectedNonce: tx.nonce,
    idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (!claims) throw new Error('missing id_token');
  const info = await client.fetchUserInfo(cfg, tokens.access_token, claims.sub);
  const roles = Array.isArray(info.roles) ? info.roles.filter((r): r is string => typeof r === 'string') : [];
  return {
    sub: claims.sub,
    email: (info.email as string | undefined) ?? (claims.email as string | undefined) ?? null,
    emailVerified: Boolean(info.email_verified ?? claims.email_verified),
    name: (info.name as string | undefined) ?? null,
    roles,
    idToken: tokens.id_token,
    accessToken: tokens.access_token,
  };
}

/** 登出時撤銷 access token（RFC 7009，auth-service 的 revocation_endpoint）；盡力而為，失敗只記 log */
export async function revokeAccessToken(accessToken: string | undefined): Promise<boolean> {
  if (!accessToken) return false;
  try {
    const cfg = await oidcConfiguration();
    if (!cfg.serverMetadata().revocation_endpoint) return false;
    await client.tokenRevocation(cfg, accessToken, { token_type_hint: 'access_token' });
    return true;
  } catch (err) {
    logger.warn({ err }, 'token revocation failed');
    return false;
  }
}

/** 全站登出網址（auth-service end_session_endpoint）；本站 session 由呼叫端清除 */
export async function endSessionUrl(idToken: string | undefined): Promise<string | null> {
  try {
    const cfg = await oidcConfiguration();
    if (!cfg.serverMetadata().end_session_endpoint) return null;
    const params: Record<string, string> = { client_id: config().OIDC_CLIENT_ID };
    if (idToken) params.id_token_hint = idToken;
    if (config().OIDC_POST_LOGOUT_REDIRECT_URI) params.post_logout_redirect_uri = config().OIDC_POST_LOGOUT_REDIRECT_URI!;
    return client.buildEndSessionUrl(cfg, params).toString();
  } catch {
    return null;
  }
}

/** 後台授權：email 白名單或 roles 任一符合；兩者都沒設時只有非 production 允許所有登入者 */
export function isAdminAllowed(user: Pick<OidcUser, 'email' | 'emailVerified' | 'roles'>): boolean {
  const c = config();
  const emails = c.ADMIN_EMAILS.map((e) => e.toLowerCase());
  const roles = c.ADMIN_ROLES;
  if (emails.length === 0 && roles.length === 0) return !c.isProduction;
  if (user.email && user.emailVerified && emails.includes(user.email.toLowerCase())) return true;
  return user.roles.some((r) => roles.includes(r));
}
