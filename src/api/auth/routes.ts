import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import { randomToken } from '../../infra/crypto/secrets.js';
import { audit } from '../../infra/db/repositories.js';
import { db } from '../../infra/db/pool.js';
import { redis } from '../../infra/redis.js';
import { HttpError } from '../../lib/errors.js';
import { endSessionUrl, finishLogin, isAdminAllowed, startLogin, type LoginTransaction } from './oidc.js';
import { createSession, destroySession, loadSession, loginTxCookieName } from './session.js';

/** 只允許站內相對路徑，避免 open redirect */
export function safeReturnTo(v: unknown): string {
  if (typeof v !== 'string' || !v.startsWith('/') || v.startsWith('//') || v.includes('\\')) return '/';
  return v.slice(0, 500);
}

const webUrl = (path: string) => new URL(path, config().ADMIN_WEB_URL).toString();

export async function authRoutes(app: FastifyInstance) {
  app.get('/auth/config', async () => ({
    oidc: config().oidcEnabled,
    issuer: config().oidcEnabled ? config().OIDC_ISSUER : null,
    dev_bypass: config().devBypass,
  }));

  app.get<{ Querystring: { return_to?: string } }>('/auth/login', async (req, reply) => {
    const returnTo = safeReturnTo(req.query.return_to);
    const c = config();
    if (!c.oidcEnabled) {
      if (!c.devBypass) throw new HttpError(503, 'oidc_not_configured', '尚未設定 auth-service（OIDC_CLIENT_ID / SECRET）');
      await createSession(reply, { sub: 'dev', email: 'dev@localhost', name: '本機開發者', roles: ['dev'], devBypass: true });
      return reply.redirect(webUrl(returnTo));
    }
    const { url, tx } = await startLogin(returnTo);
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

    let user;
    try {
      user = await finishLogin(query, tx);
    } catch (err) {
      req.log.warn({ err }, 'OIDC callback failed');
      return reply.redirect(webUrl('/login?error=callback_failed'));
    }
    if (!isAdminAllowed(user)) {
      await audit(db(), { actor: `oidc:${user.sub}`, action: 'admin.login_denied', detail: { email: user.email } });
      return reply.redirect(webUrl('/login?error=forbidden'));
    }
    await createSession(reply, {
      sub: user.sub,
      email: user.email,
      name: user.name,
      roles: user.roles,
      idToken: user.idToken,
    });
    await audit(db(), { actor: `admin:${user.email ?? user.sub}`, action: 'admin.login' });
    return reply.redirect(webUrl(tx.returnTo));
  });

  app.get('/auth/me', async (req) => {
    const s = await loadSession(req);
    if (!s) throw new HttpError(401, 'unauthenticated', '未登入');
    return { sub: s.sub, email: s.email, name: s.name, roles: s.roles, csrf_token: s.csrf, dev_bypass: Boolean(s.devBypass) };
  });

  /** 登出本站；body.global=true 時回傳 auth-service 的 end_session 網址讓前端導過去 */
  app.post<{ Body: { global?: boolean } | undefined }>('/auth/logout', async (req, reply) => {
    const s = await destroySession(req, reply);
    const global = Boolean(req.body && (req.body as { global?: boolean }).global);
    const url = global && s && !s.devBypass ? await endSessionUrl(s.idToken) : null;
    return { ok: true, end_session_url: url };
  });
}
