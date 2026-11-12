import { createHash, randomBytes } from 'node:crypto';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';

/**
 * 串接 auth-service：純 OAuth 2.0（oauth2 分支；main 分支是 OIDC 版本，其餘程式相同）。
 *
 * 刻意不使用任何 OIDC 函式庫或 OIDC 規格的功能，只依 OAuth 2.0 RFC 以 fetch 實作：
 * - RFC 6749  Authorization Code Grant、client_secret_basic（§2.3.1）
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
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: c.OAUTH2_CLIENT_ID,
    redirect_uri: c.OIDC_REDIRECT_URI,
    scope: oauth2Scope(),
    state: tx.state,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
  }).toString();
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

interface TokenResponse {
  access_token?: unknown;
  token_type?: unknown;
  id_token?: unknown;
  error?: unknown;
}

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
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok) throw new Error(`token endpoint ${res.status}: ${String(body.error ?? 'error')}`);
  if (typeof body.access_token !== 'string' || !body.access_token) throw new Error('missing access_token');
  if (typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer')
    throw new Error('unsupported token_type');
  // 拿到 ID token 代表這次其實跑成 OIDC（例如 client 設定錯），不接受
  if (body.id_token !== undefined) throw new Error('unexpected id_token in OAuth 2.0 token response');

  const accessToken = body.access_token;
  const info = await fetchUserData(accessToken);
  if (typeof info.sub !== 'string' || !info.sub) throw new Error('user data missing sub');
  const roles = Array.isArray(info.roles) ? info.roles.filter((r): r is string => typeof r === 'string') : [];
  return {
    sub: info.sub,
    email: typeof info.email === 'string' ? info.email : null,
    emailVerified: info.email_verified === true,
    name: typeof info.name === 'string' ? info.name : null,
    roles,
    accessToken,
  };
}

/** RFC 6750：Authorization: Bearer 呼叫 auth-service 的使用者資料 API */
async function fetchUserData(accessToken: string): Promise<Record<string, unknown>> {
  const res = await fetch(endpoints().userData, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`user data endpoint ${res.status}`);
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) throw new Error('user data is not JSON');
  const data = (await res.json()) as unknown;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('user data is not an object');
  return data as Record<string, unknown>;
}

/** RFC 7009 撤銷 access token（盡力而為；失敗只記 log） */
export async function revokeAccessToken(accessToken: string | undefined): Promise<boolean> {
  if (!accessToken) return false;
  try {
    const res = await postForm(endpoints().revocation, { token: accessToken, token_type_hint: 'access_token' });
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
