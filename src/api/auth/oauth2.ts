import { createHash, randomBytes } from 'node:crypto';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';

/**
 * 串接 auth-service：純 OAuth 2.0（oauth2 分支；main 分支是 OIDC 版本，其餘程式相同）。
 *
 * 刻意不使用任何 OIDC 函式庫或 OIDC 規格的功能，只依 OAuth 2.0 RFC 以 fetch 實作：
 * - RFC 6749  Authorization Code Grant、Refresh Token（§6）、client_secret_basic（§2.3.1）
 * - RFC 7636  PKCE S256
 * - RFC 9207  授權回應的 iss 參數（有回傳就驗證，防 mix-up）
 * - RFC 6750  Bearer token 呼叫受保護資源（使用者資料 API）
 * - RFC 7009  Token 撤銷
 *
 * 不做的事（都是 OIDC 的東西）：
 * - 不讀 /.well-known/openid-configuration（OIDC Discovery）→ 端點依 auth-service「純 OAuth 2.0 串接」文件明確設定
 * - 不送 openid scope、nonce，不處理 ID token（收到 ID token 直接視為設定錯誤而拒絕）
 * - 不使用 end_session_endpoint（OIDC RP-Initiated Logout）→ 只有本站登出＋撤銷 token
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

/** 純 OAuth 2.0 絕不送 openid（送了 auth-service 就會走 OIDC） */
export const oauth2Scope = () =>
  config()
    .OAUTH2_SCOPES.split(/\s+/)
    .filter((s) => s && s !== 'openid')
    .join(' ');

const b64url = (buf: Buffer) => buf.toString('base64url');

/** RFC 6749 §2.3.1：client_id／secret 先 form-urlencode 再 Base64 */
function basicAuth(): string {
  const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');
  const c = config();
  return `Basic ${Buffer.from(`${enc(c.OAUTH2_CLIENT_ID)}:${enc(c.OAUTH2_CLIENT_SECRET)}`).toString('base64')}`;
}

async function postForm(url: string, form: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: basicAuth(),
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams(form),
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
}

export interface LoginTransaction {
  state: string;
  verifier: string;
  returnTo: string;
}

export async function startLogin(returnTo: string): Promise<{ url: string; tx: LoginTransaction }> {
  const c = config();
  if (!c.oauth2Enabled) throw new Error('OAuth 2.0 未設定（OAUTH2_CLIENT_ID / OAUTH2_CLIENT_SECRET）');
  // RFC 7636：verifier 43~128 字元；32 bytes base64url = 43 字元
  const verifier = b64url(randomBytes(32));
  const tx: LoginTransaction = { state: b64url(randomBytes(32)), verifier, returnTo };
  const url = new URL(endpoints().authorization);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: c.OAUTH2_CLIENT_ID,
    redirect_uri: c.OIDC_REDIRECT_URI,
    scope: oauth2Scope(),
    state: tx.state,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()),
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

interface TokenResponse {
  access_token?: unknown;
  token_type?: unknown;
  id_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  error?: unknown;
  error_description?: unknown;
}

/** 授權伺服器回了 OAuth 錯誤（RFC 6749 §5.2，例如 invalid_grant），或使用者資料 API 回 401 */
class GrantRejected extends Error {}

/** token 端點回應檢查（授權碼與 refresh 共用）：必須是 Bearer、不能有 ID token */
async function readTokenResponse(res: Response): Promise<{ accessToken: string; expiresAt: number | undefined; refreshToken: string | undefined }> {
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok) {
    const detail = `${String(body.error ?? res.status)}${body.error_description ? `: ${String(body.error_description)}` : ''}`;
    // 4xx 且有 OAuth 錯誤碼 = 憑證或授權失效；其他（5xx、非 JSON）= 暫時性錯誤
    if (res.status >= 400 && res.status < 500 && body.error) throw new GrantRejected(detail);
    throw new Error(`token endpoint ${res.status}: ${detail}`);
  }
  if (typeof body.access_token !== 'string' || !body.access_token) throw new Error('missing access_token');
  if (typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer')
    throw new Error('unsupported token_type');
  // 拿到 ID token 代表這次其實跑成 OIDC（例如 client 設定錯），不接受
  if (body.id_token !== undefined) throw new Error('unexpected id_token in OAuth 2.0 token response');
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : Number(body.expires_in);
  return {
    accessToken: body.access_token,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
    refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : undefined,
  };
}

const userFrom = (
  info: Record<string, unknown>,
  tokens: { accessToken: string; expiresAt: number | undefined; refreshToken: string | undefined },
): SsoUser => {
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
};

/** callback：驗 state 與 iss → 以 code + verifier 換 access token → Bearer 呼叫使用者資料 API 取身分 */
export async function finishLogin(callbackQuery: string, tx: LoginTransaction): Promise<SsoUser> {
  const c = config();
  const ep = endpoints();
  const params = new URLSearchParams(callbackQuery);
  if (params.get('error')) throw new Error(`authorization error: ${params.get('error')}`);
  if (params.get('state') !== tx.state) throw new Error('state mismatch');
  // RFC 9207：授權伺服器有回 iss 就必須等於預期的 issuer（防 mix-up 攻擊）
  const iss = params.get('iss');
  if (iss !== null && iss !== ep.issuer) throw new Error('iss mismatch');
  const code = params.get('code');
  if (!code) throw new Error('missing code');

  const res = await postForm(ep.token, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: c.OIDC_REDIRECT_URI,
    code_verifier: tx.verifier,
  });
  const tokens = await readTokenResponse(res);
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
    const res = await postForm(endpoints().token, { grant_type: 'refresh_token', refresh_token: refreshToken });
    const tokens = await readTokenResponse(res);
    const user = userFrom(await fetchUserData(tokens.accessToken), {
      ...tokens,
      refreshToken: tokens.refreshToken ?? refreshToken,
    });
    if (user.sub !== expectedSub) return { kind: 'expired', reason: 'sub changed' };
    return { kind: 'ok', user };
  } catch (err) {
    if (err instanceof GrantRejected) return { kind: 'expired', reason: err.message };
    logger.warn({ err }, 'token refresh failed');
    return { kind: 'unavailable', reason: (err as Error).message };
  }
}

/** RFC 6750：Authorization: Bearer 呼叫 auth-service 的使用者資料 API */
async function fetchUserData(accessToken: string): Promise<Record<string, unknown>> {
  const res = await fetch(endpoints().userData, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  // 401：token 被撤銷、帳號停用或授權收回
  if (res.status === 401) throw new GrantRejected('user data endpoint rejected token');
  if (!res.ok) throw new Error(`user data endpoint ${res.status}`);
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) throw new Error('user data is not JSON');
  const data = (await res.json()) as unknown;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('user data is not an object');
  return data as Record<string, unknown>;
}

/** RFC 7009 撤銷 token（盡力而為；失敗只記 log） */
export async function revokeToken(
  token: string | undefined,
  hint: 'access_token' | 'refresh_token' = 'access_token',
): Promise<boolean> {
  if (!token) return false;
  try {
    const res = await postForm(endpoints().revocation, { token, token_type_hint: hint });
    if (!res.ok) logger.warn({ status: res.status }, 'token revocation failed');
    return res.ok;
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
