import type { FastifyInstance } from 'fastify';
import { config, type AuthProtocol } from '../../config.js';
import { randomToken } from '../../infra/crypto/secrets.js';
import { audit } from '../../infra/db/repositories.js';
import { db } from '../../infra/db/pool.js';
import { redis } from '../../infra/redis.js';
import { HttpError } from '../../lib/errors.js';
import {
  endSessionUrl,
  finishLogin,
  isAdminAllowed,
  isProtocolEnabled,
  revokeAccessToken,
  startLogin,
  type LoginDetails,
  type LoginTransaction,
} from './oidc.js';
import { createSession, destroySession, loadSession, loginTxCookieName } from './session.js';

/** 只允許站內相對路徑，避免 open redirect */
export function safeReturnTo(v: unknown): string {
  if (typeof v !== 'string' || !v.startsWith('/') || v.startsWith('//') || v.includes('\\')) return '/';
  return v.slice(0, 500);
}

const webUrl = (path: string) => new URL(path, config().ADMIN_WEB_URL).toString();

/** 每個使用者、每種協議保留最近一次的登入結果，供「協議比較」頁並排顯示 */
const compareKey = (sub: string, protocol: AuthProtocol) => `authcmp:${sub}:${protocol}`;
const COMPARE_TTL = 30 * 86400;

/**
 * 登入路由：
 * - GET  /auth/config            可用的登入方式
 * - GET  /auth/login?protocol=oidc|oauth2&return_to=/path
 * - GET  /auth/callback          兩種協議共用同一個回呼（交易資料記住是哪一種）
 * - GET  /auth/me                目前 session
 * - GET  /auth/compare           同一個使用者用兩種協議登入的結果
 * - POST /auth/logout            { global?: boolean }
 */
export async function authRoutes(app: FastifyInstance) {
  app.get('/auth/config', async () => ({
    protocols: config().authProtocols,
    issuer: config().authProtocols.length ? config().OIDC_ISSUER : null,
    dev_bypass: config().devBypass,
    // 舊欄位，相容既有前端
    oidc: config().oidcEnabled,
  }));

  app.get<{ Querystring: { return_to?: string; protocol?: string } }>('/auth/login', async (req, reply) => {
    const returnTo = safeReturnTo(req.query.return_to);
    const c = config();
    if (c.authProtocols.length === 0) {
      if (!c.devBypass)
        throw new HttpError(503, 'sso_not_configured', '尚未設定 auth-service client（OIDC_CLIENT_* 或 OAUTH2_CLIENT_*）');
      await createSession(reply, { sub: 'dev', email: 'dev@localhost', name: '本機開發者', roles: ['dev'], devBypass: true });
      return reply.redirect(webUrl(returnTo));
    }
    const requested = req.query.protocol ?? c.authProtocols[0];
    if (requested !== 'oidc' && requested !== 'oauth2') throw new HttpError(400, 'invalid_protocol', 'protocol 只能是 oidc 或 oauth2');
    if (!isProtocolEnabled(requested)) throw new HttpError(400, 'protocol_not_configured', `${requested} 尚未設定 client`);

    const { url, tx } = await startLogin(requested, returnTo);
    const txId = randomToken(24);
    await redis().set(`authtx:${txId}`, JSON.stringify(tx), 'EX', 600);
    reply.setCookie(loginTxCookieName(), txId, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: c.secureCookies,
      maxAge: 600,
    });
    return reply.redirect(url);
  });

  app.get('/auth/callback', async (req, reply) => {
    const txId = req.cookies[loginTxCookieName()];
    reply.clearCookie(loginTxCookieName(), { path: '/' });
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const params = new URLSearchParams(query);
    if (params.get('error')) return reply.redirect(webUrl(`/login?error=${encodeURIComponent(params.get('error')!)}`));
    if (!txId) return reply.redirect(webUrl('/login?error=login_expired'));
    // 一次性：取出就刪
    const raw = await redis().getdel(`authtx:${txId}`);
    if (!raw) return reply.redirect(webUrl('/login?error=login_expired'));
    const tx = JSON.parse(raw) as LoginTransaction;
    tx.protocol ??= 'oidc';

    let user;
    try {
      user = await finishLogin(query, tx);
    } catch (err) {
      req.log.warn({ err, protocol: tx.protocol }, 'SSO callback failed');
      return reply.redirect(webUrl('/login?error=callback_failed'));
    }
    if (!isAdminAllowed(user)) {
      await audit(db(), {
        actor: `${user.protocol}:${user.sub}`,
        action: 'admin.login_denied',
        detail: { email: user.email, protocol: user.protocol },
      });
      return reply.redirect(webUrl('/login?error=forbidden'));
    }
    await createSession(reply, {
      sub: user.sub,
      email: user.email,
      name: user.name,
      roles: user.roles,
      protocol: user.protocol,
      idToken: user.idToken,
      accessToken: user.accessToken,
    });
    await redis().set(compareKey(user.sub, user.protocol), JSON.stringify(user.details), 'EX', COMPARE_TTL);
    await audit(db(), {
      actor: `admin:${user.email ?? user.sub}`,
      action: 'admin.login',
      detail: { protocol: user.protocol },
    });
    return reply.redirect(webUrl(tx.returnTo));
  });

  app.get('/auth/me', async (req) => {
    const s = await loadSession(req);
    if (!s) throw new HttpError(401, 'unauthenticated', '未登入');
    return {
      sub: s.sub,
      email: s.email,
      name: s.name,
      roles: s.roles,
      protocol: s.protocol ?? null,
      csrf_token: s.csrf,
      dev_bypass: Boolean(s.devBypass),
    };
  });

  app.get('/auth/compare', async (req) => {
    const s = await loadSession(req);
    if (!s) throw new HttpError(401, 'unauthenticated', '未登入');
    const [oidc, oauth2] = await redis().mget(compareKey(s.sub, 'oidc'), compareKey(s.sub, 'oauth2'));
    const parse = (v: string | null | undefined) => (v ? (JSON.parse(v) as LoginDetails) : null);
    return { current: s.protocol ?? null, protocols: config().authProtocols, oidc: parse(oidc), oauth2: parse(oauth2) };
  });

  /**
   * 登出本站並撤銷 access token。
   * body.global=true 時回傳 auth-service 的 end_session 網址（OIDC 帶 id_token_hint；OAuth 2.0 沒有 ID token，只帶 client_id）。
   */
  app.post<{ Body: { global?: boolean } | undefined }>('/auth/logout', async (req, reply) => {
    const s = await destroySession(req, reply);
    const global = Boolean(req.body && (req.body as { global?: boolean }).global);
    let revoked = false;
    let url: string | null = null;
    if (s?.protocol && !s.devBypass) {
      revoked = await revokeAccessToken(s.protocol, s.accessToken);
      if (global) url = await endSessionUrl(s.protocol, s.idToken);
    }
    return { ok: true, token_revoked: revoked, end_session_url: url };
  });
}
