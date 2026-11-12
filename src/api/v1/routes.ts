import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { carriers } from '../../carriers/carrier.registry.js';
import { createStoreMapSession } from '../../domain/cvs/store-map.js';
import { labelSignedUrl, mergeLabels } from '../../domain/shipment/labels.js';
import { serializeShipment, serializeTrackingEvent } from '../../domain/shipment/serialize.js';
import { cancelShipment, createShipment, retryShipment } from '../../domain/shipment/shipment.service.js';
import { SHIPMENT_STATUSES } from '../../domain/shipment/types.js';
import { db } from '../../infra/db/pool.js';
import { getShipmentForTenant, listShipments, listTrackingEvents } from '../../infra/db/repositories.js';
import { HttpError, badRequest, notFound, zodDetails } from '../../lib/errors.js';
import { requireApiKey, requireIdempotencyKey } from './api-key.js';

const listQuery = z.object({
  external_ref: z.string().optional(),
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',') : undefined))
    .pipe(z.array(z.enum(SHIPMENT_STATUSES)).optional()),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function parseOrThrow<T extends z.ZodTypeAny>(schema: T, v: unknown): z.infer<T> {
  const r = schema.safeParse(v);
  if (!r.success) throw new HttpError(422, 'validation_failed', '參數驗證失敗', zodDetails(r.error));
  return r.data;
}

export async function v1Routes(app: FastifyInstance) {
  app.addHook('preHandler', requireApiKey);
  // 寫入類請求必帶 Idempotency-Key
  app.addHook('preHandler', async (req) => {
    if (req.method === 'POST') requireIdempotencyKey(req);
  });

  const actor = (req: { apiKeyId?: string; tenantId?: string }) => ({ id: `api_key:${req.apiKeyId}`, tenantId: req.tenantId });

  app.post('/shipments', async (req, reply) => {
    const { shipment, replayed } = await createShipment(req.tenantId!, requireIdempotencyKey(req), req.body, actor(req));
    reply.header('Idempotent-Replayed', String(replayed));
    return reply.code(replayed ? 200 : 202).send({ id: shipment.id, status: shipment.status, external_ref: shipment.external_ref });
  });

  app.get('/shipments', async (req) => {
    const q = parseOrThrow(listQuery, req.query);
    const { rows, nextCursor } = await listShipments({
      tenantId: req.tenantId!,
      externalRef: q.external_ref,
      status: q.status,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      cursor: q.cursor,
      limit: q.limit,
    });
    return { data: rows.map(serializeShipment), next_cursor: nextCursor };
  });

  app.get<{ Params: { id: string } }>('/shipments/:id', async (req) => {
    const s = await getShipmentForTenant(req.tenantId!, req.params.id);
    if (!s) throw notFound('shipment');
    return serializeShipment(s);
  });

  app.get<{ Params: { id: string } }>('/shipments/:id/tracking', async (req) => {
    const s = await getShipmentForTenant(req.tenantId!, req.params.id);
    if (!s) throw notFound('shipment');
    const events = await listTrackingEvents(s.id);
    return { shipment_id: s.id, status: s.status, tracking_number: s.tracking_number, events: events.map(serializeTrackingEvent) };
  });

  app.get<{ Params: { id: string } }>('/shipments/:id/label', async (req, reply) => {
    const s = await getShipmentForTenant(req.tenantId!, req.params.id);
    if (!s) throw notFound('shipment');
    reply.header('cache-control', 'no-store');
    return reply.redirect(await labelSignedUrl(s), 302);
  });

  app.post<{ Params: { id: string } }>('/shipments/:id/cancel', async (req) => {
    const s = await getShipmentForTenant(req.tenantId!, req.params.id);
    if (!s) throw notFound('shipment');
    return serializeShipment(await cancelShipment(s.id, actor(req)));
  });

  app.post<{ Params: { id: string } }>('/shipments/:id/retry', async (req) => {
    const s = await getShipmentForTenant(req.tenantId!, req.params.id);
    if (!s) throw notFound('shipment');
    return serializeShipment(await retryShipment(s.id, actor(req)));
  });

  app.post('/labels/batch', async (req, reply) => {
    const body = parseOrThrow(z.object({ shipment_ids: z.array(z.string().uuid()).min(1).max(100) }), req.body);
    const r = await db().query('SELECT * FROM shipments WHERE tenant_id = $1 AND id = ANY($2)', [req.tenantId, body.shipment_ids]);
    const byId = new Map(r.rows.map((s) => [s.id, s]));
    const missing = body.shipment_ids.filter((id) => !byId.has(id));
    if (missing.length) throw badRequest('部分 shipment 不存在', { missing });
    const { pdf, included, skipped } = await mergeLabels(body.shipment_ids.map((id) => byId.get(id)!));
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="labels-${Date.now()}.pdf"`)
      .header('x-labels-included', included.join(','))
      .header('x-labels-skipped', JSON.stringify(skipped))
      .send(Buffer.from(pdf));
  });

  app.get('/cvs/store-map', async (req) => {
    const q = parseOrThrow(
      z.object({
        carrier: z.string().optional(),
        carrier_account_id: z.string().uuid().optional(),
        sub_type: z.string().min(1),
        return_url: z.string().url(),
        is_collection: z.enum(['true', 'false']).optional(),
        device: z.enum(['PC', 'MOBILE']).optional(),
      }),
      req.query,
    );
    return createStoreMapSession({
      tenantId: req.tenantId!,
      carrier: q.carrier,
      carrierAccountId: q.carrier_account_id,
      subType: q.sub_type,
      returnUrl: q.return_url,
      isCollection: q.is_collection === 'true',
      device: q.device,
    });
  });

  app.get('/carriers', async () => ({ data: carrierList() }));
}

export function carrierList() {
  return carriers()
    .list()
    .map((a) => ({ code: a.code, name: a.displayName, capabilities: a.capabilities, limits: a.limits }));
}
