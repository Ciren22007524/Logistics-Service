import { carriers } from '../carriers/carrier.registry.js';
import { config } from '../config.js';
import { ingestTrackingEvents } from '../domain/shipment/shipment.service.js';
import { db } from '../infra/db/pool.js';
import { getCarrierAccount, getShipment } from '../infra/db/repositories.js';
import { enqueueFetchLabel, enqueuePoll, enqueueSubmit } from '../infra/queue/queues.js';
import { logger } from '../lib/logger.js';

const POLLABLE = ['LABEL_PENDING', 'READY_TO_SHIP', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'ARRIVED_AT_STORE', 'EXCEPTION', 'RETURNING'];

/**
 * 排程掃描（每 1–2 小時）：
 * - 非終態且超過 N 小時沒更新 → 主動查物流商（補漏）
 * - 卡在 CREATED 超過 2 分鐘 → 重新排 submit（排程失敗或 worker 重啟時的保險）
 * - LABEL_PENDING 有單號但沒標籤 → 重新排 fetch-label
 */
export async function scanForPolling(): Promise<{ polled: number; resubmitted: number; relabel: number }> {
  const c = config();
  const pollCarriers = carriers()
    .list()
    .filter((a) => a.capabilities.trackingPolling)
    .map((a) => a.code);
  const bucket = new Date().toISOString().slice(0, 13).replace(/\D/g, '');

  const stale = await db().query<{ id: string }>(
    `SELECT id FROM shipments
     WHERE status = ANY($1) AND carrier_code = ANY($2)
       AND COALESCE(last_tracking_at, updated_at) < now() - make_interval(hours => $3)
     ORDER BY COALESCE(last_tracking_at, updated_at) LIMIT 500`,
    [POLLABLE, pollCarriers, c.POLL_TRACKING_STALE_HOURS],
  );
  for (const r of stale.rows) await enqueuePoll(r.id, bucket);

  const stuck = await db().query<{ id: string }>(
    `SELECT id FROM shipments WHERE status = 'CREATED' AND updated_at < now() - interval '2 minutes' LIMIT 500`,
  );
  for (const r of stuck.rows) await enqueueSubmit(r.id, 0, Number(bucket));

  const noLabel = await db().query<{ id: string }>(
    `SELECT id FROM shipments WHERE status = 'LABEL_PENDING' AND label_url IS NULL
       AND (tracking_number IS NOT NULL OR carrier_shipment_id IS NOT NULL)
       AND updated_at < now() - interval '10 minutes' LIMIT 500`,
  );
  for (const r of noLabel.rows) await enqueueFetchLabel(r.id, Number(bucket));

  const result = { polled: stale.rowCount ?? 0, resubmitted: stuck.rowCount ?? 0, relabel: noLabel.rowCount ?? 0 };
  logger.info(result, 'poll scan done');
  return result;
}

export async function pollShipment(shipmentId: string): Promise<void> {
  const s = await getShipment(shipmentId);
  if (!s || !POLLABLE.includes(s.status)) return;
  const adapter = carriers().get(s.carrier_code);
  if (!adapter.capabilities.trackingPolling) return;
  const account = await getCarrierAccount(s.carrier_account_id);
  if (!account) return;
  const events = await adapter.queryTracking(s, account);
  const result = await ingestTrackingEvents(s.id, events, 'POLLING');
  logger.info({ shipment_id: s.id, ...result }, 'tracking polled');
}
