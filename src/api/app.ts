import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { adminRoutes } from '../admin/routes.js';
import { config } from '../config.js';
import { db } from '../infra/db/pool.js';
import { redis } from '../infra/redis.js';
import { HttpError, zodDetails } from '../lib/errors.js';
import { redactPaths } from '../lib/logger.js';
import { authRoutes } from './auth/routes.js';
import { publicRoutes } from './callbacks/routes.js';
import { v1Routes } from './v1/routes.js';

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const c = config();
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : { level: c.LOG_LEVEL, redact: { paths: redactPaths, censor: '[REDACTED]' } },
    trustProxy: c.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
  });

  app.setErrorHandler((err: Error, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError)
      return reply.code(422).send({ error: { code: 'validation_failed', message: '參數驗證失敗', details: zodDetails(err) } });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500)
      return reply.code(status).send({ error: { code: (err as { code?: string }).code ?? 'bad_request', message: err.message } });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal_error', message: '系統錯誤', request_id: req.id } });
  });

  await app.register(cookie);

  app.get('/healthz', async (_req, reply) => {
    const checks: Record<string, string> = {};
    await db()
      .query('SELECT 1')
      .then(() => (checks.db = 'ok'))
      .catch((e: Error) => (checks.db = e.message));
    await redis()
      .ping()
      .then(() => (checks.redis = 'ok'))
      .catch((e: Error) => (checks.redis = e.message));
    const ok = Object.values(checks).every((v) => v === 'ok');
    return reply.code(ok ? 200 : 503).send({ ok, checks });
  });

  await app.register(async (scope) => {
    await scope.register(formbody);
    await scope.register(authRoutes);
  });
  await app.register(v1Routes, { prefix: '/v1' });
  await app.register(adminRoutes, { prefix: '/admin/api' });
  await app.register(publicRoutes);

  // 由 API 直接提供建置好的後台（同源，不需 CORS，也不用另外開前端伺服器）
  const webDist = resolve(process.cwd(), c.WEB_DIST_DIR);
  const notFound = { error: { code: 'not_found', message: 'route not found' } };
  if (c.SERVE_WEB && existsSync(join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      wildcard: false,
      index: false,
      cacheControl: false,
      setHeaders: (res, path) => {
        // Vite 產出的 assets 檔名含 hash，可長期快取；index.html 每次都要重新取得
        const isHashed = path.startsWith(join(webDist, 'assets'));
        res.setHeader('cache-control', isHashed ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    const apiPrefixes = ['/v1/', '/admin/api/', '/auth/', '/callbacks/', '/cvs/', '/mock-carrier/', '/healthz'];
    const sendIndex = (reply: FastifyReply) =>
      reply.header('cache-control', 'no-cache').type('text/html; charset=utf-8').sendFile('index.html');
    app.get('/', (_req, reply) => sendIndex(reply));
    // SPA：前端路由（/shipments/xxx 等）重新整理時回 index.html
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0]!;
      const isApi = apiPrefixes.some((p) => path === p.replace(/\/$/, '') || path.startsWith(p));
      const isAsset = /\.[a-z0-9]+$/i.test(path);
      if ((req.method === 'GET' || req.method === 'HEAD') && !isApi && !isAsset) return sendIndex(reply);
      return reply.code(404).send(notFound);
    });
    app.log.info({ dir: webDist }, 'serving admin web');
  } else {
    if (c.SERVE_WEB) app.log.warn({ dir: webDist }, 'web/dist not found; run `npm run build:web` to serve the admin UI');
    app.setNotFoundHandler((_req, reply) => reply.code(404).send(notFound));
  }

  return app;
}
