import * as oauth from 'oauth4webapi';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';

/**
 * 串接 auth-service：純 OAuth 2.0（oauth2 分支；main 分支是 OIDC 版本，其餘程式相同）。
 *
 * 使用 oauth4webapi（同時支援 OAuth 2.0 與 OIDC 的底層函式庫），只呼叫 OAuth 2.0 RFC 的部分：
 * - RFC 6749  validateAuthResponse、authorizationCodeGrantRequest、refreshTokenGrantRequest（§6）、ClientSecretBasic
 * - RFC 7636  generateRandomCodeVerifier、calculatePKCECodeChallenge
 * - RFC 9207  validateAuthResponse 會檢查授權回應的 iss（有回傳就驗，防 mix-up）
 * - RFC 6750  protectedResourceRequest（Bearer 呼叫使用者資料 API）
 * - RFC 7009  revocationRequest
 *
 * 刻意不用的 OIDC 功能：
 * - userInfoRequest（OIDC UserInfo）→ 改用 protectedResourceRequest
 * - discoveryRequest（OIDC Discovery / RFC 8414）→ auth-service 沒有 RFC 8414 文件，端點依它「純 OAuth 2.0 串接」文件明確設定
 * - nonce、ID token 驗證 → token 回應帶 ID token 時，在交給 oauth4webapi 處理「之前」就拒絕，
 *   因為 processAuthorizationCodeResponse／processRefreshTokenResponse 遇到 ID token 會自動跑 OIDC 驗證
 * - end_session（OIDC RP-Initiated Logout）→ 只有本站登出＋撤銷 token
 *
 * Refresh token：OAuth 2.0 沒規定怎麼申請，由授權伺服器決定。auth-service 的規則是 scope 含
 * `offline_access` 且帶 `prompt=consent`（這兩個名稱來自 OIDC 規格）。本程式不寫死：
 * 由 OAUTH2_SCOPES、OAUTH2_PROMPT 設定決定送不送；token 回應有 refresh_token 就使用。
 *
 * auth-service 的端點網址都在 `/oidc/` 前綴底下，那只是它的路徑命名；不帶 openid 的 access token 呼叫
 * `/oidc/userinfo` 時，auth-service 走的是它自訂的「OAuth 使用者資料 API」，不是 OIDC UserInfo。
 */

interface Endpoints {
  issuer: string;
  authorization: string;
  token: string;
  /** auth-service 的 OAuth 使用者資料 API（RFC 6750 Bearer） */
  userData: string;
  revocation: string;
}

/** 端點：預設照 auth-service 文件，可用 OAUTH2_*_ENDPOINT 個別覆寫 */
export function endpoints(): Endpoints {
  const c = config();
  const base = c.OIDC_ISSUER.replace(/\/$/, '');
  return {
    issuer: base,
    authorization: c.OAUTH2_AUTHORIZATION_ENDPOINT ?? `${base}/oidc/auth`,
    token: c.OAUTH2_TOKEN_ENDPOINT ?? `${base}/oidc/token`,
    userData: c.OAUTH2_USER_DATA_ENDPOINT ?? `${base}/oidc/userinfo`,
    revocation: c.OAUTH2_REVOCATION_ENDPOINT ?? `${base}/oidc/token/revocation`,
  };
}

/**
 * 授權伺服器 metadata：手動組，不做 discovery。
 * 故意不填 userinfo_endpoint、jwks_uri、end_session_endpoint 這些 OIDC 欄位。
 */
function authorizationServer(): oauth.AuthorizationServer {
  const ep = endpoints();
  return {
    issuer: ep.issuer,
    authorization_endpoint: ep.authorization,
    token_endpoint: ep.token,
    revocation_endpoint: ep.revocation,
  };
}

const oauthClient = (): oauth.Client => ({ client_id: config().OAUTH2_CLIENT_ID });
const clientAuth = () => oauth.ClientSecretBasic(config().OAUTH2_CLIENT_SECRET);

/** auth-service 本機開發只允許 localhost 走 http；正式環境一律 https */
const requestOptions = () =>
  config().OIDC_ISSUER.startsWith('http://') ? { [oauth.allowInsecureRequests]: true } : {};

/** 純 OAuth 2.0 絕不送 openid（送了 auth-service 就會走 OIDC） */
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
  const c = config();
  if (!c.oauth2Enabled) throw new Error('OAuth 2.0 未設定（OAUTH2_CLIENT_ID / OAUTH2_CLIENT_SECRET）');
  const verifier = oauth.generateRandomCodeVerifier();
  const tx: LoginTransaction = { state: oauth.generateRandomState(), verifier, returnTo };
  const url = new URL(endpoints().authorization);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: c.OAUTH2_CLIENT_ID,
    redirect_uri: c.OIDC_REDIRECT_URI,
    scope: oauth2Scope(),
    state: tx.state,
    code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
  });
  // 只有設定了才送（例如 auth-service 發 refresh token 需要 consent）
  if (c.OAUTH2_PROMPT) params.set('prompt', c.OAUTH2_PROMPT);
  url.search = params.toString();
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
  /** access token 到期時間（epoch ms）；授權伺服器沒給 expires_in 時為 undefined */
  accessTokenExpiresAt: number | undefined;
  /** 授權伺服器有發才有；只存在後端 session */
  refreshToken: string | undefined;
}

/** 授權伺服器回了 OAuth 錯誤（RFC 6749 §5.2，例如 invalid_grant），或使用者資料 API 拒絕 token */
class GrantRejected extends Error {}

/**
 * 交給 oauth4webapi 處理 token 回應之前先看原文：有 ID token 就拒絕。
 * 這樣 oauth4webapi 的 ID token（OIDC）驗證程式永遠不會被執行到。
 */
async function rejectIdToken(res: Response): Promise<void> {
  if (!res.ok) return;
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { id_token?: unknown } | null;
  if (body && body.id_token !== undefined) throw new Error('unexpected id_token in OAuth 2.0 token response');
}

type Tokens = { accessToken: string; expiresAt: number | undefined; refreshToken: string | undefined };

function tokensFrom(r: oauth.TokenEndpointResponse): Tokens {
  if (r.token_type.toLowerCase() !== 'bearer') throw new Error('unsupported token_type');
  return {
    accessToken: r.access_token,
    expiresAt: typeof r.expires_in === 'number' && r.expires_in > 0 ? Date.now() + r.expires_in * 1000 : undefined,
    refreshToken: r.refresh_token || undefined,
  };
}

/** RFC 6750：Authorization: Bearer 呼叫 auth-service 的使用者資料 API */
async function fetchUserData(accessToken: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await oauth.protectedResourceRequest(
      accessToken,
      'GET',
      new URL(endpoints().userData),
      new Headers({ accept: 'application/json' }),
      null,
      requestOptions(),
    );
  } catch (err) {
    // 帶 WWW-Authenticate 的 401：token 被撤銷、帳號停用或授權收回
    if (err instanceof oauth.WWWAuthenticateChallengeError) throw new GrantRejected('user data endpoint rejected token');
    throw err;
  }
  if (res.status === 401) throw new GrantRejected('user data endpoint rejected token');
  if (!res.ok) throw new Error(`user data endpoint ${res.status}`);
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) throw new Error('user data is not JSON');
  const data = (await res.json()) as unknown;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('user data is not an object');
  return data as Record<string, unknown>;
}

function userFrom(info: Record<string, unknown>, tokens: Tokens): SsoUser {
  if (typeof info.sub !== 'string' || !info.sub) throw new Error('user data missing sub');
  return {
    sub: info.sub,
    email: typeof info.email === 'string' ? info.email : null,
    emailVerified: info.email_verified === true,
    name: typeof info.name === 'string' ? info.name : null,
    roles: Array.isArray(info.roles) ? info.roles.filter((r): r is string => typeof r === 'string') : [],
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.expiresAt,
    refreshToken: tokens.refreshToken,
  };
}

/** callback：驗 state 與 iss → 以 code + verifier 換 access token → Bearer 呼叫使用者資料 API 取身分 */
export async function finishLogin(callbackQuery: string, tx: LoginTransaction): Promise<SsoUser> {
  const c = config();
  const as = authorizationServer();
  const client = oauthClient();
  // RFC 6749 §4.1.2：檢查 state、error；RFC 9207：有 iss 就必須等於 issuer
  const callbackParams = oauth.validateAuthResponse(as, client, new URLSearchParams(callbackQuery), tx.state);
  const res = await oauth.authorizationCodeGrantRequest(
    as,
    client,
    clientAuth(),
    callbackParams,
    c.OIDC_REDIRECT_URI,
    tx.verifier,
    requestOptions(),
  );
  await rejectIdToken(res);
  const tokens = tokensFrom(await oauth.processAuthorizationCodeResponse(as, client, res));
  const user = userFrom(await fetchUserData(tokens.accessToken), tokens);
  if (oauth2Scope().split(' ').includes('offline_access') && !user.refreshToken)
    logger.warn(
      'no refresh_token issued: check OAUTH2_PROMPT (auth-service needs consent) and that the client allows offline_access',
    );
  return user;
}

export type RefreshResult =
  | { kind: 'ok'; user: SsoUser }
  /** refresh token 失效（過期、被撤銷、授權被收回）或帳號被停用：要重新登入 */
  | { kind: 'expired'; reason: string }
  /** 授權伺服器暫時連不上或回 5xx：之後再試 */
  | { kind: 'unavailable'; reason: string };

/**
 * RFC 6749 §6：用 refresh token 換新 access token，再呼叫使用者資料 API 同步角色。
 * 授權伺服器輪替 refresh token 時（回應有新的 refresh_token）就換掉舊的。
 */
export async function refreshTokens(refreshToken: string, expectedSub: string): Promise<RefreshResult> {
  try {
    const as = authorizationServer();
    const client = oauthClient();
    const res = await oauth.refreshTokenGrantRequest(as, client, clientAuth(), refreshToken, requestOptions());
    await rejectIdToken(res);
    const tokens = tokensFrom(await oauth.processRefreshTokenResponse(as, client, res));
    const user = userFrom(await fetchUserData(tokens.accessToken), {
      ...tokens,
      refreshToken: tokens.refreshToken ?? refreshToken,
    });
    if (user.sub !== expectedSub) return { kind: 'expired', reason: 'sub changed' };
    return { kind: 'ok', user };
  } catch (err) {
    // RFC 6749 §5.2 錯誤回應（invalid_grant 等）：憑證或授權已失效
    if (err instanceof oauth.ResponseBodyError)
      return { kind: 'expired', reason: err.error_description ? `${err.error}: ${err.error_description}` : err.error };
    if (err instanceof GrantRejected) return { kind: 'expired', reason: err.message };
    logger.warn({ err }, 'token refresh failed');
    return { kind: 'unavailable', reason: (err as Error).message };
  }
}

/** RFC 7009 撤銷 token（盡力而為；失敗只記 log） */
export async function revokeToken(
  token: string | undefined,
  hint: 'access_token' | 'refresh_token' = 'access_token',
): Promise<boolean> {
  if (!token) return false;
  try {
    const res = await oauth.revocationRequest(authorizationServer(), oauthClient(), clientAuth(), token, {
      ...requestOptions(),
      additionalParameters: { token_type_hint: hint },
    });
    await oauth.processRevocationResponse(res);
    return true;
  } catch (err) {
    logger.warn({ err }, 'token revocation failed');
    return false;
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
