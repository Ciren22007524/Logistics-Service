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
  const scope = config().OIDC_SCOPES;
  const url = client.buildAuthorizationUrl(cfg, {
    redirect_uri: config().OIDC_REDIRECT_URI,
    scope,
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state: tx.state,
    nonce: tx.nonce,
    // auth-service（oidc-provider）規定：申請 offline_access 必須帶 prompt=consent，否則會把 offline_access 拿掉、不發 refresh token
    ...(wantsOfflineAccess(scope) ? { prompt: 'consent' } : {}),
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
  /** access token 到期時間（epoch ms） */
  accessTokenExpiresAt: number;
  /** 有申請 offline_access 且 auth-service 核准時才有；只存在後端 session */
  refreshToken: string | undefined;
}

const wantsOfflineAccess = (scope: string) => scope.split(/\s+/).includes('offline_access');

const rolesOf = (info: Record<string, unknown>) =>
  Array.isArray(info.roles) ? info.roles.filter((r): r is string => typeof r === 'string') : [];

const expiresAtOf = (tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers) =>
  Date.now() + (tokens.expiresIn() ?? 0) * 1000;

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
  if (wantsOfflineAccess(config().OIDC_SCOPES) && !tokens.refresh_token)
    logger.warn(
      'no refresh_token issued: check that the auth-service client has offline_access enabled (登入仍可用，但角色不會自動更新)',
    );
  return {
    sub: claims.sub,
    email: (info.email as string | undefined) ?? (claims.email as string | undefined) ?? null,
    emailVerified: Boolean(info.email_verified ?? claims.email_verified),
    name: (info.name as string | undefined) ?? null,
    roles: rolesOf(info),
    idToken: tokens.id_token,
    accessToken: tokens.access_token,
    accessTokenExpiresAt: expiresAtOf(tokens),
    refreshToken: tokens.refresh_token,
  };
}

export type RefreshResult =
  | { kind: 'ok'; user: OidcUser }
  /** refresh token 失效（過期、被撤銷、授權被收回）：要重新登入 */
  | { kind: 'expired'; reason: string }
  /** auth-service 暫時連不上或回 5xx：之後再試 */
  | { kind: 'unavailable'; reason: string };

/**
 * 用 refresh token 換新的 access token，並重新取 UserInfo（角色、email、停用狀態都會同步）。
 * auth-service 剩餘效期低於 30% 時會輪替 refresh token，有回傳新的就換掉舊的。
 */
export async function refreshTokens(refreshToken: string, expectedSub: string): Promise<RefreshResult> {
  try {
    const cfg = await oidcConfiguration();
    const tokens = await client.refreshTokenGrant(cfg, refreshToken);
    // 換新時若有回 ID token，openid-client 會驗簽章與 iss／aud／exp；sub 必須是同一個人
    const claims = tokens.claims();
    if (claims && claims.sub !== expectedSub) return { kind: 'expired', reason: 'sub changed' };
    const info = await client.fetchUserInfo(cfg, tokens.access_token, expectedSub);
    return {
      kind: 'ok',
      user: {
        sub: expectedSub,
        email: (info.email as string | undefined) ?? null,
        emailVerified: Boolean(info.email_verified),
        name: (info.name as string | undefined) ?? null,
        roles: rolesOf(info),
        idToken: tokens.id_token,
        accessToken: tokens.access_token,
        accessTokenExpiresAt: expiresAtOf(tokens),
        refreshToken: tokens.refresh_token ?? refreshToken,
      },
    };
  } catch (err) {
    // OAuth 錯誤回應（invalid_grant 等）代表憑證或授權已失效；UserInfo 回 401 代表帳號被停用或授權被撤銷
    if (err instanceof client.ResponseBodyError)
      return { kind: 'expired', reason: err.error_description ? `${err.error}: ${err.error_description}` : err.error };
    if (err instanceof client.WWWAuthenticateChallengeError) return { kind: 'expired', reason: 'userinfo rejected token' };
    logger.warn({ err }, 'token refresh failed');
    return { kind: 'unavailable', reason: (err as Error).message };
  }
}

/** 登出時撤銷 token（RFC 7009，auth-service 的 revocation_endpoint）；盡力而為，失敗只記 log */
export async function revokeToken(
  token: string | undefined,
  hint: 'access_token' | 'refresh_token' = 'access_token',
): Promise<boolean> {
  if (!token) return false;
  try {
    const cfg = await oidcConfiguration();
    if (!cfg.serverMetadata().revocation_endpoint) return false;
    await client.tokenRevocation(cfg, token, { token_type_hint: hint });
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
