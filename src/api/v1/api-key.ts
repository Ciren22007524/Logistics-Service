import type { FastifyRequest } from 'fastify';
import { findApiKey } from '../../infra/db/repositories.js';
import { HttpError } from '../../lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    tenantId?: string;
    apiKeyId?: string;
  }
}

/** Authorization: Bearer <api_key> */
export async function requireApiKey(req: FastifyRequest): Promise<void> {
  const h = req.headers.authorization;
  const m = h?.match(/^Bearer\s+(lsk_[A-Za-z0-9_-]{20,100})$/);
  if (!m) throw new HttpError(401, 'unauthenticated', '缺少或錯誤的 API key');
  const key = await findApiKey(m[1]!);
  if (!key) throw new HttpError(401, 'unauthenticated', 'API key 無效或已撤銷');
  req.tenantId = key.tenant_id;
  req.apiKeyId = key.id;
}

/** 寫入類請求必帶 Idempotency-Key（規格第 7 節） */
export function requireIdempotencyKey(req: FastifyRequest): string {
  const v = req.headers['idempotency-key'];
  if (typeof v !== 'string' || !v.trim() || v.length > 200)
    throw new HttpError(400, 'idempotency_key_required', '寫入類請求必須帶 Idempotency-Key header（≤200 字）');
  return v.trim();
}
