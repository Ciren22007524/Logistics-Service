import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config.js';
import { randomToken, safeEqual } from '../../infra/crypto/secrets.js';
import { db } from '../../infra/db/pool.js';
import { audit } from '../../infra/db/repositories.js';
import { redis } from '../../infra/redis.js';
import { HttpError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { isAdminAllowed, refreshTokens, revokeToken } from './oauth2.js';

export interface AdminSession {
  id: string;
  sub: string;
  email: string | null;
  name: string | null;
  roles: string[];
  /** 只存在 Redis，登出時撤銷 */
  accessToken?: string;
  /** access token 到期時間（epoch ms） */
  accessTokenExpiresAt?: number;
  /** 只存在 Redis；有它才會自動換新 access token 並重新同步角色 */
  refreshToken?: string;
  /** 最近一次向 auth-service 確認角色的時間 */
  rolesCheckedAt?: string;
  csrf: string;
  createdAt: string;
  devBypass?: boolean;
}

/** HTTPS 時使用 __Host- 前綴（Secure、Path=/、不可設 Domain） */
export const sessionCookieName = () => (config().secureCookies ? '__Host-ls_sid' : 'ls_sid');
export const loginTxCookieName = () => (config().secureCookies ? '__Host-ls_login' : 'ls_login');

const key = (id: string) => `sess:${id}`;

export async function createSession(reply: FastifyReply, data: Omit<AdminSession, 'id' | 'csrf' | 'createdAt'>) {
  const session: AdminSession = { ...data, id: randomToken(32), csrf: randomToken(24), createdAt: new Date().toISOString() };
  await redis().set(key(session.id), JSON.stringify(session), 'EX', config().SESSION_TTL_SECONDS);
  reply.setCookie(sessionCookieName(), session.id, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config().secureCookies,
    maxAge: config().SESSION_TTL_SECONDS,
  });
  return session;
}

async function getSessionById(id: string): Promise<AdminSession | null> {
  const raw = await redis().get(key(id));
  return raw ? (JSON.parse(raw) as AdminSession) : null;
}

export async function loadSession(req: FastifyRequest): Promise<AdminSession | null> {
  const id = req.cookies[sessionCookieName()];
  if (!id || id.length > 100) return null;
  return getSessionById(id);
}

/** access token 剩不到這麼久就先換新，避免請求途中過期 */
const REFRESH_SKEW_MS = 60_000;
const LOCK_TTL_MS = 15_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isFresh = (s: AdminSession) => !s.accessTokenExpiresAt || s.accessTokenExpiresAt - Date.now() > REFRESH_SKEW_MS;

/**
 * 確保 session 的 access token 仍有效；快過期就用 refresh token 換新並重新取 UserInfo 同步角色。
 * - 同一個 session 同時只有一個請求去換（Redis 鎖）。auth-service 會輪替 refresh token，
 *   兩個請求拿同一張舊 refresh token 去換會被當成重放，可能整個授權被撤銷。
 * - refresh token 失效或帳號已無後台權限：刪 session，回 401／403，要重新登入
 * - auth-service 暫時連不上：回 503（fail closed，不用過期的角色放行）
 * - 開發登入、或沒拿到 refresh token 的 session 不處理（維持登入當下的角色，直到 session 到期）
 */
export async function ensureFreshSession(s: AdminSession, reply: FastifyReply): Promise<AdminSession> {
  if (s.devBypass || !s.refreshToken || isFresh(s)) return s;

  const lockKey = `lock:refresh:${s.id}`;
  const lockToken = randomToken(12);
  if (!(await redis().set(lockKey, lockToken, 'PX', LOCK_TTL_MS, 'NX'))) {
    // 另一個請求正在換：等它寫回新的 session
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const cur = await getSessionById(s.id);
      if (!cur) throw sessionEnded(reply);
      if (isFresh(cur)) return cur;
    }
    throw new HttpError(503, 'auth_unavailable', '登入服務暫時無法使用，請稍後再試');
  }

  try {
    // 拿到鎖後再讀一次：可能剛被別的請求換好
    const cur = await getSessionById(s.id);
    if (!cur) throw sessionEnded(reply);
    if (isFresh(cur)) return cur;

    const result = await refreshTokens(cur.refreshToken!, cur.sub);
    if (result.kind === 'unavailable')
      throw new HttpError(503, 'auth_unavailable', '登入服務暫時無法使用，請稍後再試');
    if (result.kind === 'expired') {
      logger.info({ sub: cur.sub, reason: result.reason }, 'refresh token rejected; session ended');
      await redis().del(key(cur.id));
      throw sessionEnded(reply);
    }
    const u = result.user;
    if (!isAdminAllowed(u)) {
      await redis().del(key(cur.id));
      await revokeToken(u.refreshToken, 'refresh_token');
      await audit(db(), { actor: `oauth2:${u.sub}`, action: 'admin.access_revoked', detail: { email: u.email, roles: u.roles } });
      reply.clearCookie(sessionCookieName(), { path: '/' });
      throw new HttpError(403, 'forbidden', '你的後台權限已被移除');
    }
    const updated: AdminSession = {
      ...cur,
      email: u.email,
      name: u.name,
      roles: u.roles,
      accessToken: u.accessToken,
      accessTokenExpiresAt: u.accessTokenExpiresAt,
      refreshToken: u.refreshToken,
      rolesCheckedAt: new Date().toISOString(),
    };
    // KEEPTTL：換新不延長本站 session 的絕對期限
    await redis().set(key(cur.id), JSON.stringify(updated), 'KEEPTTL');
    return updated;
  } finally {
    await redis().eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      lockKey,
      lockToken,
    );
  }
}

function sessionEnded(reply: FastifyReply): HttpError {
  reply.clearCookie(sessionCookieName(), { path: '/' });
  return new HttpError(401, 'session_expired', '登入已過期，請重新登入');
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply): Promise<AdminSession | null> {
  const s = await loadSession(req);
  if (s) await redis().del(key(s.id));
  reply.clearCookie(sessionCookieName(), { path: '/' });
  return s;
}

declare module 'fastify' {
  interface FastifyRequest {
    admin?: AdminSession;
  }
}

const allowedOrigins = () => new Set([new URL(config().ADMIN_WEB_URL).origin, new URL(config().PUBLIC_BASE_URL).origin]);

/** 後台 API：需登入（必要時換新 token、重新同步角色）；寫入類需 CSRF token 與同源 Origin */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const loaded = await loadSession(req);
  if (!loaded) throw new HttpError(401, 'unauthenticated', '請先登入');
  const s = await ensureFreshSession(loaded, reply);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins().has(origin)) throw new HttpError(403, 'bad_origin', '來源不允許');
    const token = req.headers['x-csrf-token'];
    if (typeof token !== 'string' || !safeEqual(token, s.csrf)) throw new HttpError(403, 'csrf', 'CSRF token 錯誤');
  }
  req.admin = s;
}
