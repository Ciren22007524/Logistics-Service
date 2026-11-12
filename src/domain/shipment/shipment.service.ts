import type pg from 'pg';
import type { CarrierAccount, CarrierAdapter, CarrierTrackingEvent } from '../../carriers/carrier.interface.js';
import { carriers } from '../../carriers/carrier.registry.js';
import { ValidationError as CarrierValidationError, toCarrierError } from '../../carriers/errors.js';
import { config } from '../../config.js';
import { sha256 } from '../../infra/crypto/secrets.js';
import { db, tx } from '../../infra/db/pool.js';
import {
  audit,
  getCarrierAccount,
  getShipment,
  listCarrierAccountsDecrypted,
  lockShipment,
} from '../../infra/db/repositories.js';
import { enqueueSubmit } from '../../infra/queue/queues.js';
import { redis } from '../../infra/redis.js';
import { HttpError, badRequest, conflict, zodDetails } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { insertOutboxEvent, shipmentEventData } from '../../outbox/outbox.js';
import { CANCELLABLE, RETRYABLE, checkTransition } from './state-machine.js';
import type { ShipmentRow, ShipmentStatus, TrackingSource } from './types.js';
import { createShipmentSchema, toCarrierInput, validateForCarrier, type CreateShipmentRequest } from './validation.js';

export interface Actor {
  /** 'api_key:<id>' | 'admin:<email>' | 'system:<worker>' */
  id: string;
  tenantId?: string | null;
}

export function callbackUrlFor(account: { id: string; carrier_code: string }): string {
  return new URL(`/callbacks/${account.carrier_code}/${account.id}`, config().PUBLIC_BASE_URL).toString();
}

/** 開發與測試環境禁止使用正式帳號（規格 9.5） */
export function assertAccountAllowed(account: CarrierAccount): void {
  if (!config().isProduction && !account.is_sandbox)
    throw new HttpError(422, 'production_account_forbidden', '非正式環境禁止使用正式物流商帳號（is_sandbox=false）');
}

async function resolveAccount(
  tenantId: string,
  req: CreateShipmentRequest,
): Promise<{ account: CarrierAccount; adapter: CarrierAdapter }> {
  if (req.carrier_account_id) {
    const account = await getCarrierAccount(req.carrier_account_id);
    if (!account || account.tenant_id !== tenantId) throw badRequest('carrier_account_id 不存在');
    const adapter = carriers().find(account.carrier_code);
    if (!adapter) throw new HttpError(422, 'carrier_unavailable', `物流商 ${account.carrier_code} 目前未啟用`);
    return { account, adapter };
  }
  // 未指定：找支援此服務類型的預設帳號；門市有標 carrier_code 時優先
  const accounts = await listCarrierAccountsDecrypted(tenantId);
  const wanted = req.cvs_store?.carrier_code;
  const candidates = accounts
    .filter((a) => a.is_default)
    .map((a) => ({ account: a, adapter: carriers().find(a.carrier_code) }))
    .filter((x): x is { account: CarrierAccount; adapter: CarrierAdapter } => Boolean(x.adapter))
    .filter((x) =>
      req.service_type === 'HOME_DELIVERY' ? x.adapter.capabilities.homeDelivery : x.adapter.capabilities.cvsPickup,
    )
    .sort((a, b) => Number(b.account.carrier_code === wanted) - Number(a.account.carrier_code === wanted));
  const first = candidates[0];
  if (!first) throw new HttpError(422, 'no_default_account', `沒有支援 ${req.service_type} 的預設物流商帳號`);
  return first;
}

function canonicalHash(body: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
          )
        : v;
  return sha256(JSON.stringify(sort(body)));
}

export interface CreateResult {
  shipment: ShipmentRow;
  replayed: boolean;
}

/**
 * 建立託運單（非同步送物流商）。
 * 冪等：(tenant_id, idempotency_key) 唯一鍵；同 key 併發只會有一筆，內容不同回 409。
 */
export async function createShipment(
  tenantId: string,
  idempotencyKey: string,
  body: unknown,
  actor: Actor,
): Promise<CreateResult> {
  if (!idempotencyKey || idempotencyKey.length > 200) throw badRequest('缺少或過長的 Idempotency-Key header');
  const parsed = createShipmentSchema.safeParse(body);
  if (!parsed.success)
    throw new HttpError(422, 'validation_failed', '欄位驗證失敗', zodDetails(parsed.error));
  const requestHash = canonicalHash(parsed.data);

  // 先查既有，避免重送時因帳號設定變更而報錯
  const existing = await findByIdempotencyKey(tenantId, idempotencyKey);
  if (existing) return replay(existing, requestHash);

  const { account, adapter } = await resolveAccount(tenantId, parsed.data);
  assertAccountAllowed(account);
  const { errors, normalized } = validateForCarrier(parsed.data, adapter);
  // adapter 特定規則（例如綠界姓名長度）也在建單前先擋
  if (Object.keys(errors).length === 0 && adapter.validate) {
    Object.assign(
      errors,
      adapter.validate(toCarrierInput('00000000-0000-0000-0000-000000000000', normalized, account.sender_info, '')),
    );
  }
  if (Object.keys(errors).length) throw new HttpError(422, 'validation_failed', '資料未通過物流商規則', errors);

  const inserted = await tx(async (c) => {
    const r = await c.query<ShipmentRow>(
      `INSERT INTO shipments (
         tenant_id, carrier_account_id, carrier_code, service_type, external_ref, idempotency_key, request_hash,
         recipient, cvs_store, temperature, cod_amount, declared_value, items_summary,
         scheduled_pickup_at, preferred_time_slot, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [
        tenantId,
        account.id,
        account.carrier_code,
        normalized.service_type,
        normalized.external_ref,
        idempotencyKey,
        requestHash,
        JSON.stringify(normalized.recipient),
        normalized.cvs_store ? JSON.stringify({ ...normalized.cvs_store, carrier_code: account.carrier_code }) : null,
        normalized.temperature,
        normalized.cod_amount ?? null,
        normalized.declared_value ?? null,
        normalized.items_summary,
        normalized.scheduled_pickup_at ?? null,
        normalized.preferred_time_slot ?? null,
        JSON.stringify(normalized.metadata),
      ],
    );
    const row = r.rows[0];
    if (!row) return null;
    const p = normalized.package;
    await c.query(
      'INSERT INTO packages (shipment_id, weight_g, length_cm, width_cm, height_cm, size_code) VALUES ($1,$2,$3,$4,$5,$6)',
      [row.id, p?.weight_g ?? null, p?.length_cm ?? null, p?.width_cm ?? null, p?.height_cm ?? null, p?.size_code ?? null],
    );
    await audit(c, { tenant_id: tenantId, actor: actor.id, action: 'shipment.create', target_id: row.id });
    return row;
  });

  if (!inserted) {
    // 併發：另一個請求先寫入了同一個 key
    const winner = await findByIdempotencyKey(tenantId, idempotencyKey);
    if (!winner) throw new Error('idempotency race: row vanished');
    return replay(winner, requestHash);
  }

  // commit 之後才排程；若排程失敗，poll-tracking 會把卡在 CREATED 的單補送
  await enqueueSubmit(inserted.id).catch((err) => logger.error({ err, shipment_id: inserted.id }, 'enqueue submit failed'));
  return { shipment: inserted, replayed: false };
}

async function findByIdempotencyKey(tenantId: string, key: string): Promise<ShipmentRow | null> {
  const r = await db().query<ShipmentRow>('SELECT * FROM shipments WHERE tenant_id = $1 AND idempotency_key = $2', [
    tenantId,
    key,
  ]);
  return r.rows[0] ?? null;
}

function replay(existing: ShipmentRow, requestHash: string): CreateResult {
  if (existing.request_hash && existing.request_hash !== requestHash)
    throw conflict('同一個 Idempotency-Key 已用於內容不同的請求', { shipment_id: existing.id });
  return { shipment: existing, replayed: true };
}

// ---------------------------------------------------------------------------
// 狀態轉換：狀態更新與 outbox 寫入在同一個 transaction
// ---------------------------------------------------------------------------

export interface TransitionOptions {
  occurredAt?: Date;
  error?: string | null;
  /** 一併更新的欄位 */
  set?: Partial<Pick<ShipmentRow, 'tracking_number' | 'carrier_shipment_id' | 'carrier_payload' | 'last_error'>>;
  reason?: string;
}

/**
 * 呼叫前必須先在同一個 client 上 lockShipment（FOR UPDATE）。
 * 不合法轉換寫 log 並回傳 null（物流商回調順序可能錯亂）。
 */
export async function transition(
  c: pg.PoolClient,
  shipment: ShipmentRow,
  to: ShipmentStatus,
  opts: TransitionOptions = {},
): Promise<ShipmentRow | null> {
  const check = checkTransition(shipment.status, to, shipment.service_type);
  if (!check.ok) {
    if (check.reason !== 'same_status')
      logger.warn(
        { shipment_id: shipment.id, from: shipment.status, to, reason: check.reason, why: opts.reason },
        'illegal status transition ignored',
      );
    return null;
  }
  const occurredAt = opts.occurredAt ?? new Date();
  const set = opts.set ?? {};
  const r = await c.query<ShipmentRow>(
    `UPDATE shipments SET
       status = $2,
       tracking_number = COALESCE($3, tracking_number),
       carrier_shipment_id = COALESCE($4, carrier_shipment_id),
       carrier_payload = COALESCE($5, carrier_payload),
       last_error = CASE WHEN $6::boolean THEN $7 ELSE last_error END,
       delivered_at = CASE WHEN $2 = 'DELIVERED' THEN $8 ELSE delivered_at END,
       cancelled_at = CASE WHEN $2 = 'CANCELLED' THEN now() ELSE cancelled_at END,
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [
      shipment.id,
      to,
      set.tracking_number ?? null,
      set.carrier_shipment_id ?? null,
      set.carrier_payload ? JSON.stringify(set.carrier_payload) : null,
      opts.error !== undefined,
      opts.error ?? null,
      occurredAt,
    ],
  );
  const updated = r.rows[0]!;
  const data = shipmentEventData(updated, { previous_status: shipment.status, occurred_at: occurredAt });
  await insertOutboxEvent(c, updated.tenant_id, 'shipment.status_changed', data);
  if (to === 'FAILED') await insertOutboxEvent(c, updated.tenant_id, 'shipment.failed', { ...data, error: opts.error });
  if (to === 'EXCEPTION')
    await insertOutboxEvent(c, updated.tenant_id, 'shipment.exception', { ...data, reason: opts.reason ?? null });
  logger.info({ shipment_id: shipment.id, from: shipment.status, to }, 'shipment status changed');
  return updated;
}

/** 便利包裝：自己開 transaction、上鎖再轉換 */
export async function transitionById(id: string, to: ShipmentStatus, opts: TransitionOptions = {}) {
  return tx(async (c) => {
    const s = await lockShipment(c, id);
    if (!s) return null;
    return transition(c, s, to, opts);
  });
}

// ---------------------------------------------------------------------------
// 軌跡事件（回調、輪詢、手動）
// ---------------------------------------------------------------------------

export interface IngestResult {
  inserted: number;
  duplicates: number;
  applied: number;
  status: ShipmentStatus;
}

/**
 * 寫 tracking_events → 推進狀態 → 寫 outbox（同一個 transaction）。
 * - 唯一鍵 (shipment_id, raw_status, occurred_at) 擋重複
 * - 比「已套用的最新事件」還舊的事件只保留軌跡，不推進狀態（亂序保護）
 */
export async function ingestTrackingEvents(
  shipmentId: string,
  events: CarrierTrackingEvent[],
  source: TrackingSource,
): Promise<IngestResult> {
  return tx(async (c) => {
    let shipment = await lockShipment(c, shipmentId);
    if (!shipment) throw new Error(`shipment ${shipmentId} not found`);
    const latest = await c.query<{ at: Date | null }>(
      'SELECT max(occurred_at) AS at FROM tracking_events WHERE shipment_id = $1 AND applied',
      [shipmentId],
    );
    let latestApplied = latest.rows[0]?.at ?? null;
    const result: IngestResult = { inserted: 0, duplicates: 0, applied: 0, status: shipment.status };

    for (const ev of [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())) {
      const ins = await c.query<{ id: string }>(
        `INSERT INTO tracking_events (shipment_id, status, raw_status, description, location, occurred_at, source, raw_payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (shipment_id, raw_status, occurred_at) DO NOTHING RETURNING id`,
        [
          shipmentId,
          ev.status ?? shipment.status,
          ev.rawStatus,
          ev.description ?? null,
          ev.location ?? null,
          ev.occurredAt,
          source,
          ev.raw === undefined ? null : JSON.stringify(ev.raw),
        ],
      );
      const eventId = ins.rows[0]?.id;
      if (!eventId) {
        result.duplicates++;
        continue;
      }
      result.inserted++;
      if (!ev.status) continue;
      if (latestApplied && ev.occurredAt < latestApplied) {
        logger.info({ shipment_id: shipmentId, raw_status: ev.rawStatus }, 'out-of-order tracking event kept as history');
        continue;
      }
      const updated = await transition(c, shipment, ev.status, {
        occurredAt: ev.occurredAt,
        reason: ev.description ?? ev.rawStatus,
      });
      if (updated) {
        shipment = updated;
        latestApplied = ev.occurredAt;
        result.applied++;
        await c.query('UPDATE tracking_events SET applied = true WHERE id = $1', [eventId]);
      }
    }
    await c.query('UPDATE shipments SET last_tracking_at = now() WHERE id = $1', [shipmentId]);
    result.status = shipment.status;
    return result;
  });
}

// ---------------------------------------------------------------------------
// 取消、重送
// ---------------------------------------------------------------------------

/** 與 submit-shipment worker 共用的鎖，避免「正在送物流商」時同時取消 */
export async function withShipmentLock<T>(shipmentId: string, fn: () => Promise<T>, ttlMs = 120_000): Promise<T> {
  const key = `lock:shipment:${shipmentId}`;
  const token = `${process.pid}-${Date.now()}-${Math.random()}`;
  const ok = await redis().set(key, token, 'PX', ttlMs, 'NX');
  if (!ok) throw new HttpError(409, 'busy', '此託運單正在處理中，請稍後再試');
  try {
    return await fn();
  } finally {
    // 只刪自己的鎖
    await redis().eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      key,
      token,
    );
  }
}

export async function cancelShipment(shipmentId: string, actor: Actor): Promise<ShipmentRow> {
  return withShipmentLock(shipmentId, async () => {
    const s = await getShipment(shipmentId);
    if (!s) throw new HttpError(404, 'not_found', 'shipment not found');
    if (s.status === 'CANCELLED') return s;
    if (!CANCELLABLE.includes(s.status))
      throw new HttpError(409, 'not_cancellable', `狀態 ${s.status} 無法取消（已交寄或已結束）`);

    // 已送到物流商的才需要呼叫物流商取消
    if (s.tracking_number || s.carrier_shipment_id) {
      const adapter = carriers().get(s.carrier_code);
      if (!adapter.capabilities.cancel)
        throw new HttpError(409, 'carrier_cannot_cancel', `${s.carrier_code} 不支援 API 取消，請至物流商後台處理`);
      const account = await getCarrierAccount(s.carrier_account_id);
      if (!account) throw new Error('carrier account missing');
      try {
        await adapter.cancelShipment(s, account);
      } catch (err) {
        const e = toCarrierError(err);
        throw new HttpError(e instanceof CarrierValidationError ? 409 : 502, 'carrier_cancel_failed', e.message);
      }
    }
    const updated = await tx(async (c) => {
      const locked = await lockShipment(c, shipmentId);
      const u = locked ? await transition(c, locked, 'CANCELLED', { reason: 'cancelled' }) : null;
      await audit(c, { tenant_id: s.tenant_id, actor: actor.id, action: 'shipment.cancel', target_id: s.id });
      return u;
    });
    if (!updated) throw new HttpError(409, 'not_cancellable', '狀態已變更，請重新整理');
    return updated;
  });
}

/** 失敗單重新送出：FAILED → CREATED，清除錯誤後重新排程 */
export async function retryShipment(shipmentId: string, actor: Actor): Promise<ShipmentRow> {
  const updated = await tx(async (c) => {
    const s = await lockShipment(c, shipmentId);
    if (!s) throw new HttpError(404, 'not_found', 'shipment not found');
    if (s.status === 'CREATED') return s;
    if (!RETRYABLE.includes(s.status)) throw new HttpError(409, 'not_retryable', `狀態 ${s.status} 不能重新送出`);
    const r = await c.query<ShipmentRow>(
      `UPDATE shipments SET status = 'CREATED', last_error = NULL, attempt_count = 0, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [s.id],
    );
    const u = r.rows[0]!;
    await insertOutboxEvent(c, u.tenant_id, 'shipment.status_changed', shipmentEventData(u, { previous_status: s.status }));
    await audit(c, { tenant_id: s.tenant_id, actor: actor.id, action: 'shipment.retry', target_id: s.id });
    return u;
  });
  await enqueueSubmit(updated.id, 0, Date.now());
  return updated;
}
