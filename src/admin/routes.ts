import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../api/auth/session.js';
import { carrierList, parseOrThrow } from '../api/v1/routes.js';
import { carriers } from '../carriers/carrier.registry.js';
import { MOCK_STATUS_CODES, buildMockCallback } from '../carriers/mock/mock.adapter.js';
import { config } from '../config.js';
import { createStoreMapSession } from '../domain/cvs/store-map.js';
import { labelSignedUrl, mergeLabels } from '../domain/shipment/labels.js';
import { serializeShipment, serializeTrackingEvent } from '../domain/shipment/serialize.js';
import { cancelShipment, createShipment, retryShipment, type Actor } from '../domain/shipment/shipment.service.js';
import { allowedNext } from '../domain/shipment/state-machine.js';
import { SHIPMENT_STATUSES } from '../domain/shipment/types.js';
import { receiveCallback } from '../domain/tracking/callbacks.js';
import { randomToken } from '../infra/crypto/secrets.js';
import { db, tx } from '../infra/db/pool.js';
import {
  audit,
  createApiKey,
  createCarrierAccount,
  createTenant,
  getCarrierAccount,
  getPackage,
  getShipment,
  listApiKeys,
  listCarrierAccounts,
  listShipments,
  listTenants,
  listTrackingEvents,
  revokeApiKey,
  updateTenant,
} from '../infra/db/repositories.js';
import { enqueueFetchLabelForce } from '../infra/queue/queues.js';
import { HttpError, badRequest, notFound } from '../lib/errors.js';
import { toTaipeiIso } from '../lib/time.js';
import { webhookEnvelope, type OutboxRow } from '../outbox/outbox.js';

const actorOf = (req: { admin?: { email: string | null; sub: string } }): Actor => ({
  id: `admin:${req.admin?.email ?? req.admin?.sub}`,
});

const iso = <T extends object>(row: T, keys: (keyof T)[]) => {
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const k of keys) out[k as string] = toTaipeiIso(row[k] as unknown as Date | null);
  return out;
};

const tenantOut = (t: Awaited<ReturnType<typeof listTenants>>[number]) => ({
  ...iso(t, ['created_at']),
  webhook_secret: `${t.webhook_secret.slice(0, 10)}…`,
});

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin);

  app.get('/dashboard', async () => {
    const [byStatus, outbox, callbacks, recentFailed] = await Promise.all([
      db().query<{ status: string; n: string }>('SELECT status, count(*) AS n FROM shipments GROUP BY status'),
      db().query<{ status: string; n: string }>('SELECT status, count(*) AS n FROM outbox_events GROUP BY status'),
      db().query<{ n: string }>(
        `SELECT count(*) AS n FROM carrier_callbacks WHERE error IS NOT NULL AND received_at > now() - interval '24 hours'`,
      ),
      db().query(
        `SELECT id, external_ref, carrier_code, last_error, updated_at FROM shipments
         WHERE status = 'FAILED' ORDER BY updated_at DESC LIMIT 5`,
      ),
    ]);
    return {
      shipments_by_status: Object.fromEntries(byStatus.rows.map((r) => [r.status, Number(r.n)])),
      outbox_by_status: Object.fromEntries(outbox.rows.map((r) => [r.status, Number(r.n)])),
      callback_errors_24h: Number(callbacks.rows[0]?.n ?? 0),
      recent_failed: recentFailed.rows.map((r) => iso(r, ['updated_at'])),
      env: config().APP_ENV,
      mock_carrier: config().mockCarrierEnabled,
    };
  });

  // ---------------- shipments ----------------

  app.get('/shipments', async (req) => {
    const q = parseOrThrow(
      z.object({
        tenant_id: z.string().uuid().optional(),
        status: z.string().optional(),
        carrier_code: z.string().optional(),
        q: z.string().max(100).optional(),
        cursor: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      }),
      req.query,
    );
    const statuses = q.status?.split(',').filter((s) => (SHIPMENT_STATUSES as readonly string[]).includes(s));
    const { rows, nextCursor } = await listShipments({
      tenantId: q.tenant_id,
      status: statuses,
      carrierCode: q.carrier_code,
      q: q.q?.trim() || undefined,
      cursor: q.cursor,
      limit: q.limit,
    });
    return { data: rows.map(serializeShipment), next_cursor: nextCursor };
  });

  app.get<{ Params: { id: string } }>('/shipments/:id', async (req) => {
    const s = await getShipment(req.params.id);
    if (!s) throw notFound('shipment');
    const [events, outbox, audits, callbacks, pkg] = await Promise.all([
      listTrackingEvents(s.id),
      db().query<OutboxRow>(
        `SELECT * FROM outbox_events WHERE payload->'data'->>'shipment_id' = $1 ORDER BY id DESC LIMIT 50`,
        [s.id],
      ),
      db().query('SELECT * FROM audit_logs WHERE target_id = $1 ORDER BY id DESC LIMIT 50', [s.id]),
      db().query(
        'SELECT id, carrier_code, kind, verified, processed_at, error, received_at, body FROM carrier_callbacks WHERE shipment_id = $1 ORDER BY id DESC LIMIT 20',
        [s.id],
      ),
      getPackage(s.id),
    ]);
    const adapter = carriers().find(s.carrier_code);
    return {
      shipment: serializeShipment(s),
      tenant_id: s.tenant_id,
      idempotency_key: s.idempotency_key,
      carrier_payload: s.carrier_payload,
      package: pkg,
      allowed_next: allowedNext(s.status),
      capabilities: adapter?.capabilities ?? null,
      tracking_events: events.map((e) => ({ ...serializeTrackingEvent(e), raw_payload: e.raw_payload })),
      outbox_events: outbox.rows.map((o) => ({
        ...iso(o, ['created_at', 'next_retry_at', 'sent_at']),
        envelope: webhookEnvelope(o),
      })),
      audit_logs: audits.rows.map((a) => iso(a, ['created_at'])),
      callbacks: callbacks.rows.map((c) => iso(c, ['received_at', 'processed_at'])),
      mock_status_codes: s.carrier_code === 'MOCK' ? MOCK_STATUS_CODES : null,
    };
  });

  /** 後台建立測試託運單（與上游 API 同一個流程） */
  app.post('/shipments', async (req, reply) => {
    const body = req.body as { tenant_id?: string; idempotency_key?: string } & Record<string, unknown>;
    const { tenant_id, idempotency_key, ...payload } = body ?? {};
    if (!tenant_id) throw badRequest('tenant_id required');
    const { shipment, replayed } = await createShipment(
      tenant_id,
      idempotency_key || `admin-${randomToken(12)}`,
      payload,
      actorOf(req),
    );
    return reply.code(replayed ? 200 : 202).send(serializeShipment(shipment));
  });

  app.post<{ Params: { id: string } }>('/shipments/:id/cancel', async (req) =>
    serializeShipment(await cancelShipment(req.params.id, actorOf(req))),
  );

  app.post<{ Params: { id: string } }>('/shipments/:id/retry', async (req) =>
    serializeShipment(await retryShipment(req.params.id, actorOf(req))),
  );

  /** 重新取號／重新抓標籤 */
  app.post<{ Params: { id: string } }>('/shipments/:id/refetch-label', async (req) => {
    const s = await getShipment(req.params.id);
    if (!s) throw notFound('shipment');
    if (!s.tracking_number && !s.carrier_shipment_id) throw new HttpError(409, 'not_submitted', '尚未取得託運單號');
    await enqueueFetchLabelForce(s.id);
    await audit(db(), { tenant_id: s.tenant_id, actor: actorOf(req).id, action: 'shipment.refetch_label', target_id: s.id });
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/shipments/:id/label', async (req, reply) => {
    const s = await getShipment(req.params.id);
    if (!s) throw notFound('shipment');
    return reply.header('cache-control', 'no-store').redirect(await labelSignedUrl(s), 302);
  });

  /** 模擬物流商回調（只限 MOCK）：走完整的回調入口 → 驗簽 → 佇列 → 狀態機 */
  app.post<{ Params: { id: string }; Body: { status_code?: string; description?: string } }>(
    '/shipments/:id/simulate',
    async (req) => {
      if (!config().mockCarrierEnabled) throw new HttpError(404, 'not_found', 'mock carrier disabled');
      const s = await getShipment(req.params.id);
      if (!s) throw notFound('shipment');
      if (s.carrier_code !== 'MOCK') throw badRequest('只有 MOCK 物流商可以模擬');
      if (!s.tracking_number) throw new HttpError(409, 'not_submitted', '尚未取號');
      const code = req.body?.status_code ?? '';
      if (!MOCK_STATUS_CODES[code]) throw badRequest('未知的模擬狀態碼', { allowed: Object.keys(MOCK_STATUS_CODES) });
      const account = await getCarrierAccount(s.carrier_account_id);
      if (!account?.credentials.callbackSecret) throw new HttpError(500, 'misconfigured', 'MOCK 帳號缺少 callbackSecret');
      const { body, signature } = buildMockCallback(account.credentials.callbackSecret, {
        tracking_number: s.tracking_number,
        status_code: code,
        description: req.body?.description,
        location: '模擬轉運中心',
        occurred_at: new Date().toISOString(),
      });
      const ack = await receiveCallback('MOCK', account.id, {
        headers: { 'content-type': 'application/json', 'x-mock-signature': signature, 'user-agent': 'admin-simulator' },
        query: {},
        contentType: 'application/json',
        body,
      });
      return { ack };
    },
  );

  app.post('/labels/batch', async (req, reply) => {
    const body = parseOrThrow(z.object({ shipment_ids: z.array(z.string().uuid()).min(1).max(100) }), req.body);
    const r = await db().query('SELECT * FROM shipments WHERE id = ANY($1)', [body.shipment_ids]);
    const byId = new Map(r.rows.map((s) => [s.id, s]));
    const list = body.shipment_ids.map((id) => byId.get(id)).filter(Boolean);
    const { pdf, skipped } = await mergeLabels(list);
    return reply
      .header('content-type', 'application/pdf')
      .header('x-labels-skipped', JSON.stringify(skipped))
      .send(Buffer.from(pdf));
  });

  // ---------------- outbox / callbacks ----------------

  app.get<{ Querystring: { status?: string; limit?: string } }>('/outbox', async (req) => {
    const status = ['PENDING', 'SENT', 'DEAD'].includes(req.query.status ?? '') ? req.query.status : null;
    const r = await db().query<OutboxRow>(
      'SELECT * FROM outbox_events WHERE ($1::text IS NULL OR status = $1) ORDER BY id DESC LIMIT 100',
      [status],
    );
    return { data: r.rows.map((o) => ({ ...iso(o, ['created_at', 'next_retry_at', 'sent_at']), envelope: webhookEnvelope(o) })) };
  });

  /** 手動重送 webhook（DEAD 或 SENT 都可） */
  app.post<{ Params: { id: string } }>('/outbox/:id/redeliver', async (req) => {
    if (!/^\d+$/.test(req.params.id)) throw notFound('event');
    const r = await db().query(
      `UPDATE outbox_events SET status = 'PENDING', attempt_count = 0, next_retry_at = now(), last_error = NULL
       WHERE id = $1 RETURNING tenant_id`,
      [req.params.id],
    );
    if (!r.rows[0]) throw notFound('event');
    await audit(db(), { tenant_id: r.rows[0].tenant_id, actor: actorOf(req).id, action: 'outbox.redeliver', detail: { event_id: req.params.id } });
    return { ok: true };
  });

  app.get<{ Querystring: { errors?: string } }>('/callbacks', async (req) => {
    const r = await db().query(
      `SELECT id, carrier_code, kind, carrier_account_id, shipment_id, verified, processed_at, error, received_at, body
       FROM carrier_callbacks WHERE ($1::boolean IS FALSE OR error IS NOT NULL) ORDER BY id DESC LIMIT 100`,
      [req.query.errors === 'true'],
    );
    return { data: r.rows.map((c) => iso(c, ['received_at', 'processed_at'])) };
  });

  // ---------------- tenants / api keys ----------------

  const tenantBody = z.object({
    name: z.string().trim().min(1).max(100),
    webhook_url: z.string().url().nullable().optional(),
    store_map_return_origins: z
      .array(z.string().url().transform((u) => new URL(u).origin))
      .max(20)
      .optional(),
  });

  app.get('/tenants', async () => ({ data: (await listTenants()).map(tenantOut) }));

  app.post('/tenants', async (req, reply) => {
    const body = parseOrThrow(tenantBody, req.body);
    const t = await createTenant(body);
    await audit(db(), { tenant_id: t.id, actor: actorOf(req).id, action: 'tenant.create', target_id: t.id });
    // 建立時完整顯示一次 webhook secret
    return reply.code(201).send({ ...tenantOut(t), webhook_secret: t.webhook_secret });
  });

  app.patch<{ Params: { id: string } }>('/tenants/:id', async (req) => {
    const body = parseOrThrow(tenantBody.partial().extend({ rotate_secret: z.boolean().optional() }), req.body);
    const t = await updateTenant(req.params.id, body);
    if (!t) throw notFound('tenant');
    await audit(db(), { tenant_id: t.id, actor: actorOf(req).id, action: 'tenant.update', target_id: t.id, detail: { ...body } });
    return body.rotate_secret ? { ...tenantOut(t), webhook_secret: t.webhook_secret } : tenantOut(t);
  });

  app.get<{ Params: { id: string } }>('/tenants/:id/api-keys', async (req) => ({
    data: (await listApiKeys(req.params.id)).map((k) => iso(k, ['created_at', 'revoked_at', 'last_used_at'])),
  }));

  app.post<{ Params: { id: string }; Body: { label?: string } }>('/tenants/:id/api-keys', async (req, reply) => {
    const { key, row } = await createApiKey(req.params.id, req.body?.label?.slice(0, 100) ?? null);
    await audit(db(), { tenant_id: req.params.id, actor: actorOf(req).id, action: 'api_key.create', target_id: row.id });
    return reply.code(201).send({ ...iso(row, ['created_at']), key });
  });

  app.delete<{ Params: { id: string; keyId: string } }>('/tenants/:id/api-keys/:keyId', async (req) => {
    if (!(await revokeApiKey(req.params.id, req.params.keyId))) throw notFound('api key');
    await audit(db(), { tenant_id: req.params.id, actor: actorOf(req).id, action: 'api_key.revoke', target_id: req.params.keyId });
    return { ok: true };
  });

  // ---------------- carriers / accounts ----------------

  app.get('/carriers', async () => ({ data: carrierList() }));

  app.get<{ Querystring: { tenant_id?: string } }>('/carrier-accounts', async (req) => ({
    data: (await listCarrierAccounts(req.query.tenant_id || undefined)).map((a) => iso(a, ['created_at'])),
  }));

  app.post('/carrier-accounts', async (req, reply) => {
    const body = parseOrThrow(
      z.object({
        tenant_id: z.string().uuid(),
        carrier_code: z.string().min(1),
        name: z.string().trim().min(1).max(100),
        credentials: z.record(z.string()),
        is_sandbox: z.boolean().default(true),
        is_default: z.boolean().default(false),
        sender_info: z.object({
          name: z.string().min(1),
          phone: z.string().min(8),
          zip: z.string().optional(),
          address: z.string().optional(),
          email: z.string().email().optional(),
        }),
      }),
      req.body,
    );
    if (!carriers().find(body.carrier_code)) throw badRequest(`未啟用的物流商 ${body.carrier_code}`);
    if (!config().isProduction && !body.is_sandbox)
      throw new HttpError(422, 'production_account_forbidden', '非正式環境不可新增正式帳號');
    const credentials = { ...body.credentials };
    if (body.carrier_code === 'MOCK' && !credentials.callbackSecret) credentials.callbackSecret = randomToken(24);
    const id = await tx(async (c) => {
      const newId = await createCarrierAccount({ ...body, carrier_code: body.carrier_code.toUpperCase(), credentials }, c);
      await audit(c, { tenant_id: body.tenant_id, actor: actorOf(req).id, action: 'carrier_account.create', target_id: newId });
      return newId;
    });
    return reply.code(201).send({ id });
  });

  /** 後台測試選店：導回後台頁面 */
  app.post('/cvs/store-map', async (req) => {
    const body = parseOrThrow(
      z.object({ tenant_id: z.string().uuid(), carrier_account_id: z.string().uuid(), sub_type: z.string().min(1), return_path: z.string().startsWith('/') }),
      req.body,
    );
    const webOrigin = new URL(config().ADMIN_WEB_URL).origin;
    return createStoreMapSession({
      tenantId: body.tenant_id,
      carrierAccountId: body.carrier_account_id,
      subType: body.sub_type,
      returnUrl: new URL(body.return_path, webOrigin).toString(),
      extraAllowedOrigins: [webOrigin],
    });
  });
}
