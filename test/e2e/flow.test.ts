/**
 * 整合測試：需要真的 PostgreSQL 與 Redis。
 *   TEST_DATABASE_URL=postgresql://logistics:logistics-local-only@127.0.0.1:25432/logistics_test
 *   TEST_REDIS_URL=redis://127.0.0.1:26379/15
 * 未設定時整個檔案跳過。S3 以記憶體替身取代。
 */
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const objects = new Map<string, { body: Uint8Array; type: string }>();
vi.mock('../../src/infra/storage/s3.js', () => ({
  ensureBucket: async () => undefined,
  putObject: async (key: string, body: Uint8Array, type: string) => void objects.set(key, { body, type }),
  getObject: async (key: string) => {
    const o = objects.get(key);
    if (!o) throw new Error('NoSuchKey');
    return o.body;
  },
  signedUrl: async (key: string) => `http://s3.test/${key}?X-Amz-Signature=fake`,
}));

const DB = process.env.TEST_DATABASE_URL;
const REDIS = process.env.TEST_REDIS_URL;

describe.skipIf(!DB || !REDIS)('end-to-end flow', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let apiKey: string;
  let mockAccountId: string;
  let callbackSecret: string;
  let webhookSecret: string;

  // 延後載入：先設好環境變數
  let mod: {
    db: typeof import('../../src/infra/db/pool.js');
    repo: typeof import('../../src/infra/db/repositories.js');
    submit: typeof import('../../src/workers/submit-shipment.js');
    label: typeof import('../../src/workers/fetch-label.js');
    callbacks: typeof import('../../src/domain/tracking/callbacks.js');
    dispatcher: typeof import('../../src/outbox/dispatcher.js');
    mock: typeof import('../../src/carriers/mock/mock.adapter.js');
    queues: typeof import('../../src/infra/queue/queues.js');
    redis: typeof import('../../src/infra/redis.js');
    crypto: typeof import('../../src/infra/crypto/secrets.js');
    daily: typeof import('../../src/workers/daily-checks.js');
  };

  beforeAll(async () => {
    Object.assign(process.env, {
      APP_ENV: 'test',
      DATABASE_URL: DB,
      REDIS_URL: REDIS,
      CREDENTIALS_ENC_KEYS: randomBytes(32).toString('base64'),
      AUTH_DEV_BYPASS: 'true',
      ENABLE_MOCK_CARRIER: 'true',
      PUBLIC_BASE_URL: 'http://localhost:4310',
      ADMIN_WEB_URL: 'http://localhost:5310',
      OAUTH2_CLIENT_ID: '',
      OAUTH2_CLIENT_SECRET: '',
    });
    mod = {
      db: await import('../../src/infra/db/pool.js'),
      repo: await import('../../src/infra/db/repositories.js'),
      submit: await import('../../src/workers/submit-shipment.js'),
      label: await import('../../src/workers/fetch-label.js'),
      callbacks: await import('../../src/domain/tracking/callbacks.js'),
      dispatcher: await import('../../src/outbox/dispatcher.js'),
      mock: await import('../../src/carriers/mock/mock.adapter.js'),
      queues: await import('../../src/infra/queue/queues.js'),
      redis: await import('../../src/infra/redis.js'),
      crypto: await import('../../src/infra/crypto/secrets.js'),
      daily: await import('../../src/workers/daily-checks.js'),
    };
    const pool = mod.db.db();
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const { migrate } = await import('../../src/infra/db/migrate.js');
    await migrate(pool, resolve(import.meta.dirname, '../../migrations'));
    await mod.redis.redis().flushdb();

    const tenant = await mod.repo.createTenant({
      name: 'T1',
      webhook_url: 'https://upstream.test/hook',
      store_map_return_origins: ['https://shop.test'],
    });
    tenantId = tenant.id;
    webhookSecret = tenant.webhook_secret;
    apiKey = (await mod.repo.createApiKey(tenantId, 'test')).key;
    callbackSecret = 'cb-secret';
    mockAccountId = await mod.db.tx((c) =>
      mod.repo.createCarrierAccount(
        {
          tenant_id: tenantId,
          carrier_code: 'MOCK',
          name: 'mock',
          credentials: { callbackSecret },
          is_sandbox: true,
          is_default: true,
          sender_info: { name: '寄件人', phone: '0911222333' },
        },
        c,
      ),
    );
    const { buildApp } = await import('../../src/api/app.js');
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app?.close();
    await mod?.queues.closeQueues();
    await mod?.redis.closeRedis();
    await mod?.db.closeDb();
  });

  beforeEach(async () => {
    await mod.db.db().query("UPDATE outbox_events SET status = 'SENT' WHERE status = 'PENDING'");
  });

  const auth = { authorization: '' };
  const headers = (key?: string) => ({
    authorization: `Bearer ${apiKey}`,
    ...(key ? { 'idempotency-key': key } : {}),
  });
  const body = (over: Record<string, unknown> = {}) => ({
    external_ref: 'ORD-20261112-0001',
    service_type: 'HOME_DELIVERY',
    recipient: { name: '王小明', phone: '0912345678', zip: '330', address: '桃園市桃園區某某路1號' },
    package: { weight_g: 1200, length_cm: 30, width_cm: 20, height_cm: 10 },
    declared_value: 1500,
    items_summary: '服飾一批',
    preferred_time_slot: 'AFTERNOON',
    metadata: { channel: 'web' },
    ...over,
  });
  const create = (key: string, b = body()) => app.inject({ method: 'POST', url: '/v1/shipments', headers: headers(key), payload: b });

  const shipmentRow = async (id: string) => (await mod.repo.getShipment(id))!;

  const sendMockCallback = (trackingNumber: string, status_code: string, occurred_at: string, secret = callbackSecret) => {
    const { body: b, signature } = mod.mock.buildMockCallback(secret, { tracking_number: trackingNumber, status_code, occurred_at });
    return app.inject({
      method: 'POST',
      url: `/callbacks/MOCK/${mockAccountId}`,
      headers: { 'content-type': 'application/json', 'x-mock-signature': signature },
      payload: b,
    });
  };

  const processPendingCallbacks = async () => {
    const r = await mod.db.db().query<{ id: string }>(
      'SELECT id FROM carrier_callbacks WHERE verified AND processed_at IS NULL ORDER BY id',
    );
    for (const row of r.rows) await mod.callbacks.processCallback(row.id);
  };

  it('rejects missing/invalid API key and missing Idempotency-Key', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/shipments', headers: auth })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/shipments', headers: { authorization: 'Bearer lsk_wrongwrongwrongwrongwrong' } })).statusCode).toBe(401);
    const r = await app.inject({ method: 'POST', url: '/v1/shipments', headers: headers(), payload: body() });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('idempotency_key_required');
  });

  it('validates input before creating', async () => {
    const r = await create('bad-1', body({ recipient: { name: '王小明', phone: '12345678', address: '某某路' } }));
    expect(r.statusCode).toBe(422);
    expect(Object.keys(r.json().error.details)).toEqual(expect.arrayContaining(['recipient.phone', 'recipient.address']));
    const r2 = await create('bad-2', body({ recipient: { name: '', phone: '1' } }));
    expect(Object.keys(r2.json().error.details)).toEqual(expect.arrayContaining(['recipient.name', 'recipient.phone']));
    const n = await mod.db.db().query("SELECT count(*)::int AS n FROM shipments WHERE idempotency_key LIKE 'bad-%'");
    expect(n.rows[0].n).toBe(0);
  });

  it('idempotency: same key returns same shipment; different body → 409; concurrent → one row', async () => {
    const a = await create('idem-1');
    expect(a.statusCode).toBe(202);
    expect(a.json()).toMatchObject({ status: 'CREATED', external_ref: 'ORD-20261112-0001' });
    const b = await create('idem-1');
    expect(b.statusCode).toBe(200);
    expect(b.json().id).toBe(a.json().id);
    expect(b.headers['idempotent-replayed']).toBe('true');
    const c = await create('idem-1', body({ external_ref: 'OTHER' }));
    expect(c.statusCode).toBe(409);

    const results = await Promise.all(Array.from({ length: 10 }, () => create('idem-concurrent')));
    const ids = new Set(results.map((r) => r.json().id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.statusCode === 202)).toHaveLength(1);
    const n = await mod.db.db().query("SELECT count(*)::int AS n FROM shipments WHERE idempotency_key = 'idem-concurrent'");
    expect(n.rows[0].n).toBe(1);
  });

  it('full lifecycle: submit → label → callbacks (dup, out-of-order) → delivered → webhooks', async () => {
    const id = (await create('life-1')).json().id as string;

    expect(await mod.submit.submitShipment(id)).toBe('submitted');
    let s = await shipmentRow(id);
    expect(s.status).toBe('LABEL_PENDING');
    expect(s.tracking_number).toMatch(/^\d{12}$/);
    // 可重入：再跑一次不會重送
    expect(await mod.submit.submitShipment(id)).toBe('skipped');

    expect(await mod.label.fetchLabel(id)).toBe('stored');
    s = await shipmentRow(id);
    expect(s.status).toBe('READY_TO_SHIP');
    expect(objects.get(s.label_url!)?.type).toBe('application/pdf');
    expect(await mod.label.fetchLabel(id)).toBe('skipped');

    const labelRes = await app.inject({ method: 'GET', url: `/v1/shipments/${id}/label`, headers: headers() });
    expect(labelRes.statusCode).toBe(302);
    expect(labelRes.headers.location).toContain('X-Amz-Signature');

    const tn = s.tracking_number!;
    expect((await sendMockCallback(tn, 'M10', '2026-11-12T01:00:00Z')).statusCode).toBe(200);
    expect((await sendMockCallback(tn, 'M20', '2026-11-12T03:00:00Z')).statusCode).toBe(200);
    // 重複回調
    expect((await sendMockCallback(tn, 'M20', '2026-11-12T03:00:00Z')).statusCode).toBe(200);
    await processPendingCallbacks();
    expect((await shipmentRow(id)).status).toBe('IN_TRANSIT');

    // 亂序：送達先到，取件晚到
    await sendMockCallback(tn, 'M40', '2026-11-12T08:00:00Z');
    await sendMockCallback(tn, 'M30', '2026-11-12T05:00:00Z');
    await processPendingCallbacks();
    s = await shipmentRow(id);
    expect(s.status).toBe('DELIVERED');
    expect(s.delivered_at?.toISOString()).toBe('2026-11-12T08:00:00.000Z');

    const tracking = (await app.inject({ method: 'GET', url: `/v1/shipments/${id}/tracking`, headers: headers() })).json();
    expect(tracking.events.map((e: { raw_status: string }) => e.raw_status)).toEqual(['M10', 'M20', 'M30', 'M40']);
    expect(tracking.events.find((e: { raw_status: string }) => e.raw_status === 'M30').applied).toBe(false);
    expect(tracking.events[0].occurred_at).toBe('2026-11-12T09:00:00+08:00');

    // outbox：每次狀態變更一筆 + label_ready
    const ev = await mod.db.db().query<{ event_type: string; payload: { data: { status: string; previous_status?: string } } }>(
      `SELECT event_type, payload FROM outbox_events WHERE payload->'data'->>'shipment_id' = $1 ORDER BY id`,
      [id],
    );
    expect(ev.rows.map((r) => `${r.event_type}:${r.payload.data.status}`)).toEqual([
      'shipment.status_changed:LABEL_PENDING',
      'shipment.status_changed:READY_TO_SHIP',
      'shipment.label_ready:READY_TO_SHIP',
      'shipment.status_changed:PICKED_UP',
      'shipment.status_changed:IN_TRANSIT',
      'shipment.status_changed:DELIVERED',
    ]);
    expect(ev.rows.at(-1)!.payload.data.previous_status).toBe('IN_TRANSIT');

    // 投遞：上游先 500 再成功；驗證簽章
    const seen: { headers: Headers; body: string }[] = [];
    let fail = true;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      seen.push({ headers: new Headers(init.headers), body: String(init.body) });
      return new Response('', { status: fail ? 500 : 200 });
    }) as unknown as typeof fetch;
    const first = await mod.dispatcher.dispatchBatch(50, fakeFetch);
    expect(first.failed).toBe(6);
    const retry = await mod.db.db().query(
      "SELECT attempt_count, next_retry_at > now() + interval '50 seconds' AS later FROM outbox_events WHERE status = 'PENDING'",
    );
    expect(retry.rows.every((r) => r.attempt_count === 1 && r.later)).toBe(true);
    await mod.db.db().query("UPDATE outbox_events SET next_retry_at = now() WHERE status = 'PENDING'");
    fail = false;
    expect((await mod.dispatcher.dispatchBatch(50, fakeFetch)).sent).toBe(6);
    const last = seen.at(-1)!;
    expect(last.headers.get('x-signature')).toBe(mod.crypto.hmacSha256(webhookSecret, last.body));
    expect(JSON.parse(last.body)).toMatchObject({ type: 'shipment.status_changed', data: { status: 'DELIVERED', metadata: { channel: 'web' } } });
    expect(JSON.parse(last.body).id).toMatch(/^evt_\d+$/);
  });

  it('rejects callbacks with bad signature and records them', async () => {
    const id = (await create('sig-1')).json().id as string;
    await mod.submit.submitShipment(id);
    const s = await shipmentRow(id);
    const r = await sendMockCallback(s.tracking_number!, 'M10', '2026-11-12T01:00:00Z', 'wrong-secret');
    expect(r.statusCode).toBe(400);
    const row = await mod.db.db().query('SELECT verified, error FROM carrier_callbacks ORDER BY id DESC LIMIT 1');
    expect(row.rows[0]).toMatchObject({ verified: false, error: 'signature verification failed' });
    const bad = await app.inject({ method: 'POST', url: `/callbacks/MOCK/${mockAccountId}`, headers: { 'content-type': 'text/plain' }, payload: 'not json' });
    expect(bad.statusCode).toBe(400);
    expect((await shipmentRow(id)).status).toBe('LABEL_PENDING');
  });

  it('carrier validation error → FAILED + shipment.failed; retry → CREATED → submitted', async () => {
    const id = (await create('fail-1', body({ recipient: { name: '驗證失敗', phone: '0912345678', address: '台北市中正區1號' } }))).json().id;
    expect(await mod.submit.submitShipment(id)).toBe('failed');
    const s = await shipmentRow(id);
    expect(s.status).toBe('FAILED');
    expect(s.last_error).toContain('[VALIDATION]');
    const failed = await mod.db.db().query(
      `SELECT 1 FROM outbox_events WHERE event_type = 'shipment.failed' AND payload->'data'->>'shipment_id' = $1`,
      [id],
    );
    expect(failed.rowCount).toBe(1);

    const r = await app.inject({ method: 'POST', url: `/v1/shipments/${id}/retry`, headers: headers('retry-1') });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe('CREATED');
  });

  it('retryable error schedules another attempt', async () => {
    const id = (await create('rt-1', body({ recipient: { name: '王小明', phone: '0912345678', address: '台北市中正區1號 #retry' } }))).json().id;
    expect(await mod.submit.submitShipment(id)).toBe('retry_scheduled');
    let s = await shipmentRow(id);
    expect(s.status).toBe('CREATED');
    expect(s.last_error).toContain('[RETRYABLE]');
    expect(await mod.submit.submitShipment(id)).toBe('submitted');
    s = await shipmentRow(id);
    expect(s.attempt_count).toBe(2);
  });

  it('cancel before pickup; not after', async () => {
    const id = (await create('cancel-1')).json().id;
    await mod.submit.submitShipment(id);
    const r = await app.inject({ method: 'POST', url: `/v1/shipments/${id}/cancel`, headers: headers('c1') });
    expect(r.json().status).toBe('CANCELLED');
    const again = await app.inject({ method: 'POST', url: `/v1/shipments/${id}/cancel`, headers: headers('c2') });
    expect(again.json().status).toBe('CANCELLED');

    const id2 = (await create('cancel-2')).json().id;
    await mod.submit.submitShipment(id2);
    await sendMockCallback((await shipmentRow(id2)).tracking_number!, 'M10', '2026-11-12T01:00:00Z');
    await processPendingCallbacks();
    const no = await app.inject({ method: 'POST', url: `/v1/shipments/${id2}/cancel`, headers: headers('c3') });
    expect(no.statusCode).toBe(409);
  });

  it('lists with cursor pagination and filters', async () => {
    const p1 = (await app.inject({ method: 'GET', url: '/v1/shipments?limit=2', headers: headers() })).json();
    expect(p1.data).toHaveLength(2);
    expect(p1.next_cursor).toBeTruthy();
    const p2 = (await app.inject({ method: 'GET', url: `/v1/shipments?limit=2&cursor=${p1.next_cursor}`, headers: headers() })).json();
    expect(p2.data[0].id).not.toBe(p1.data[1].id);
    const delivered = (await app.inject({ method: 'GET', url: '/v1/shipments?status=DELIVERED', headers: headers() })).json();
    expect(delivered.data.every((d: { status: string }) => d.status === 'DELIVERED')).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/v1/shipments?status=NOPE', headers: headers() })).statusCode).toBe(422);
  });

  it('CVS store map flow (mock): token → map → selection → redirect back; then create CVS shipment', async () => {
    const bad = await app.inject({
      method: 'GET',
      url: '/v1/cvs/store-map?carrier=MOCK&sub_type=MOCK711&return_url=https://evil.test/x',
      headers: headers(),
    });
    expect(bad.statusCode).toBe(422);
    const r = await app.inject({
      method: 'GET',
      url: `/v1/cvs/store-map?carrier=MOCK&sub_type=MOCK711&return_url=${encodeURIComponent('https://shop.test/checkout?step=2')}`,
      headers: headers(),
    });
    expect(r.statusCode).toBe(200);
    const token = new URL(r.json().url).pathname.split('/').pop()!;
    const page = await app.inject({ method: 'GET', url: `/cvs/store-map/${token}` });
    expect(page.statusCode).toBe(302);
    expect(page.headers.location).toContain('/mock-carrier/store-map');
    const sel = await app.inject({
      method: 'POST',
      url: '/cvs/store-selection/MOCK',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `state=${token}&store_id=991182`,
    });
    expect(sel.statusCode).toBe(303);
    const back = new URL(sel.headers.location as string);
    expect(back.origin).toBe('https://shop.test');
    expect(back.searchParams.get('step')).toBe('2');
    expect(back.searchParams.get('store_id')).toBe('991182');
    // token 一次性
    const replay = await app.inject({
      method: 'POST',
      url: '/cvs/store-selection/MOCK',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `state=${token}&store_id=991182`,
    });
    expect(replay.statusCode).toBe(400);

    const cvs = await create(
      'cvs-1',
      body({
        service_type: 'CVS_PICKUP',
        recipient: { name: '王小明', phone: '0912345678' },
        cvs_store: { sub_type: 'MOCK711', store_id: '991182', carrier_code: 'MOCK' },
        cod_amount: 990,
      }),
    );
    expect(cvs.statusCode).toBe(202);
    const id = cvs.json().id;
    await mod.submit.submitShipment(id);
    await mod.label.fetchLabel(id);
    const tn = (await shipmentRow(id)).tracking_number!;
    await sendMockCallback(tn, 'M31', '2026-11-01T01:00:00Z');
    await processPendingCallbacks();
    expect((await shipmentRow(id)).status).toBe('ARRIVED_AT_STORE');
    // 到店多日未取 → 提醒上游（只發一次）
    expect(await mod.daily.cvsExpiryCheck()).toBe(1);
    expect(await mod.daily.cvsExpiryCheck()).toBe(0);
  });

  it('batch label merge', async () => {
    const ids = (await mod.db.db().query("SELECT id FROM shipments WHERE label_url IS NOT NULL")).rows.map((r) => r.id);
    const r = await app.inject({ method: 'POST', url: '/v1/labels/batch', headers: headers('batch-1'), payload: { shipment_ids: ids } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('webhook gives up after schedule exhausted → DEAD', async () => {
    await mod.db.db().query("UPDATE outbox_events SET status='SENT'");
    const { rows } = await mod.db.db().query<{ id: string }>(
      "INSERT INTO outbox_events (tenant_id, event_type, payload, attempt_count) VALUES ($1, 'shipment.status_changed', '{\"data\":{}}', 6) RETURNING id",
      [tenantId],
    );
    const stats = await mod.dispatcher.dispatchBatch(10, (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch);
    expect(stats.dead).toBe(1);
    const r = await mod.db.db().query('SELECT status, last_error FROM outbox_events WHERE id = $1', [rows[0]!.id]);
    expect(r.rows[0]).toMatchObject({ status: 'DEAD', last_error: 'ECONNREFUSED' });
  });

  it('admin API requires session and CSRF; dev bypass login works', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/api/dashboard' })).statusCode).toBe(401);
    const login = await app.inject({ method: 'GET', url: '/auth/login?return_to=/shipments' });
    expect(login.statusCode).toBe(302);
    expect(login.headers.location).toBe('http://localhost:5310/shipments');
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    const csrf = me.json().csrf_token;
    expect(csrf).toBeTruthy();
    const dash = await app.inject({ method: 'GET', url: '/admin/api/dashboard', headers: { cookie } });
    expect(dash.statusCode).toBe(200);
    expect(dash.json().shipments_by_status.DELIVERED).toBeGreaterThan(0);

    const noCsrf = await app.inject({ method: 'POST', url: '/admin/api/tenants', headers: { cookie }, payload: { name: 'x' } });
    expect(noCsrf.statusCode).toBe(403);
    const badOrigin = await app.inject({
      method: 'POST',
      url: '/admin/api/tenants',
      headers: { cookie, 'x-csrf-token': csrf, origin: 'https://evil.test' },
      payload: { name: 'x' },
    });
    expect(badOrigin.statusCode).toBe(403);
    const ok = await app.inject({
      method: 'POST',
      url: '/admin/api/tenants',
      headers: { cookie, 'x-csrf-token': csrf, origin: 'http://localhost:5310' },
      payload: { name: 'T2', store_map_return_origins: ['https://a.test/path'] },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().store_map_return_origins).toEqual(['https://a.test']);
    expect(ok.json().webhook_secret).toMatch(/^whsec_/);

    // 後台模擬回調走完整流程
    const id = (await create('admin-sim')).json().id;
    await mod.submit.submitShipment(id);
    const sim = await app.inject({
      method: 'POST',
      url: `/admin/api/shipments/${id}/simulate`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { status_code: 'M10' },
    });
    expect(sim.json().ack.status).toBe(200);
    await processPendingCallbacks();
    expect((await shipmentRow(id)).status).toBe('PICKED_UP');

    const detail = await app.inject({ method: 'GET', url: `/admin/api/shipments/${id}`, headers: { cookie } });
    expect(detail.json().tracking_events).toHaveLength(1);
    expect(detail.json().audit_logs[0].action).toBe('shipment.create');

    const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie }, payload: {} });
    expect(logout.json().ok).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('non-production refuses production carrier accounts', async () => {
    const prodId = await mod.db.tx((c) =>
      mod.repo.createCarrierAccount(
        {
          tenant_id: tenantId,
          carrier_code: 'MOCK',
          name: 'prod',
          credentials: { callbackSecret: 'x' },
          is_sandbox: false,
          is_default: false,
          sender_info: { name: 'a', phone: '0911222333' },
        },
        c,
      ),
    );
    const r = await create('prod-1', body({ carrier_account_id: prodId }));
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('production_account_forbidden');
  });

  it('healthz', async () => {
    const r = await app.inject({ method: 'GET', url: '/healthz' });
    expect(r.json()).toEqual({ ok: true, checks: { db: 'ok', redis: 'ok' } });
  });
});
