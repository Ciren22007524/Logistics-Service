import type { ShipmentRow, ShipmentStatus } from '../domain/shipment/types.js';
import type { Queryable } from '../infra/db/pool.js';
import { toTaipeiIso } from '../lib/time.js';

export const EVENT_TYPES = [
  'shipment.label_ready',
  'shipment.status_changed',
  'shipment.failed',
  'shipment.exception',
  'shipment.cvs_pickup_expiring',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** 失敗後的重試間隔（規格 7.4）：1m, 5m, 30m, 2h, 6h, 24h，用盡標記 DEAD */
export const RETRY_SCHEDULE_SECONDS = [60, 300, 1800, 7200, 21600, 86400];

export interface OutboxRow {
  id: string;
  tenant_id: string;
  event_type: EventType;
  payload: { data: Record<string, unknown> };
  status: 'PENDING' | 'SENT' | 'DEAD';
  attempt_count: number;
  next_retry_at: Date;
  last_error: string | null;
  sent_at: Date | null;
  created_at: Date;
}

/** 必須在與狀態更新相同的 transaction 內呼叫（規格第 5 節設計重點） */
export async function insertOutboxEvent(
  q: Queryable,
  tenantId: string,
  type: EventType,
  data: Record<string, unknown>,
): Promise<string> {
  const r = await q.query<{ id: string }>(
    'INSERT INTO outbox_events (tenant_id, event_type, payload) VALUES ($1, $2, $3) RETURNING id',
    [tenantId, type, JSON.stringify({ data })],
  );
  return r.rows[0]!.id;
}

export function shipmentEventData(
  s: ShipmentRow,
  extra: { previous_status?: ShipmentStatus | null; occurred_at?: Date | null; [k: string]: unknown } = {},
): Record<string, unknown> {
  const { previous_status, occurred_at, ...rest } = extra;
  return {
    shipment_id: s.id,
    external_ref: s.external_ref,
    ...(previous_status !== undefined ? { previous_status } : {}),
    status: s.status,
    carrier_code: s.carrier_code,
    tracking_number: s.tracking_number,
    occurred_at: toTaipeiIso(occurred_at ?? new Date()),
    metadata: s.metadata,
    ...rest,
  };
}

/** Webhook 封包（規格 7.4）；id 由 outbox id 衍生，重送時固定，上游以此冪等 */
export function webhookEnvelope(row: Pick<OutboxRow, 'id' | 'event_type' | 'created_at' | 'payload'>) {
  return {
    id: `evt_${row.id}`,
    type: row.event_type,
    created_at: toTaipeiIso(row.created_at),
    data: row.payload.data,
  };
}

export function nextRetryDelaySeconds(attemptCount: number): number | null {
  return RETRY_SCHEDULE_SECONDS[attemptCount - 1] ?? null;
}
