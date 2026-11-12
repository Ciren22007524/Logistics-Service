import type { FastifyReply, FastifyRequest } from 'fastify';
import { config, type AuthProtocol } from '../../config.js';
import { randomToken, safeEqual } from '../../infra/crypto/secrets.js';
import { redis } from '../../infra/redis.js';
import { HttpError } from '../../lib/errors.js';

export interface AdminSession {
  id: string;
  sub: string;
  email: string | null;
  name: string | null;
  roles: string[];
  /** 這次登入用的協議；開發登入為 undefined */
  protocol?: AuthProtocol;
  idToken?: string;
  /** 只存在 Redis，登出時撤銷 */
  accessToken?: string;
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

export async function loadSession(req: FastifyRequest): Promise<AdminSession | null> {
  const id = req.cookies[sessionCookieName()];
  if (!id || id.length > 100) return null;
  const raw = await redis().get(key(id));
  return raw ? (JSON.parse(raw) as AdminSession) : null;
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

/** 後台 API：需登入；寫入類需 CSRF token 與同源 Origin */
export async function requireAdmin(req: FastifyRequest): Promise<void> {
  const s = await loadSession(req);
  if (!s) throw new HttpError(401, 'unauthenticated', '請先登入');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins().has(origin)) throw new HttpError(403, 'bad_origin', '來源不允許');
    const token = req.headers['x-csrf-token'];
    if (typeof token !== 'string' || !safeEqual(token, s.csrf)) throw new HttpError(403, 'csrf', 'CSRF token 錯誤');
  }
  req.admin = s;
}
