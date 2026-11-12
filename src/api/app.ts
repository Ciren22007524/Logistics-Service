import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
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

  // 正式環境由 API 直接提供後台前端（同源，不需 CORS）
  const webDist = resolve(process.cwd(), 'web/dist');
  if (c.SERVE_WEB && existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/', wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      const apiPrefixes = ['/v1', '/admin/api', '/auth', '/callbacks', '/cvs', '/healthz'];
      if (req.method === 'GET' && !apiPrefixes.some((p) => req.url.startsWith(p)))
        return reply.type('text/html').sendFile('index.html', join(webDist));
      return reply.code(404).send({ error: { code: 'not_found', message: 'route not found' } });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'route not found' } }));
  }

  return app;
}
