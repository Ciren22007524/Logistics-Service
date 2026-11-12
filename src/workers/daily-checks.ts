import { config } from '../config.js';
import type { ShipmentRow } from '../domain/shipment/types.js';
import { db, tx } from '../infra/db/pool.js';
import { alert } from '../lib/alert.js';
import { toTaipeiIso } from '../lib/time.js';
import { insertOutboxEvent, shipmentEventData } from '../outbox/outbox.js';

/** stale-alert：找出卡在某狀態過久的單 */
export async function staleAlert(): Promise<Record<string, number>> {
  const c = config();
  const rules: { status: string; interval: string; label: string }[] = [
    { status: 'CREATED', interval: '1 hour', label: '建立後超過 1 小時未送出' },
    { status: 'LABEL_PENDING', interval: '1 day', label: '等待取號／標籤超過 1 天' },
    { status: 'READY_TO_SHIP', interval: `${c.STALE_READY_TO_SHIP_DAYS} days`, label: `待交寄超過 ${c.STALE_READY_TO_SHIP_DAYS} 天` },
    { status: 'EXCEPTION', interval: '1 day', label: '異常超過 1 天未處理' },
    { status: 'IN_TRANSIT', interval: '5 days', label: '運送中超過 5 天' },
  ];
  const counts: Record<string, number> = {};
  for (const rule of rules) {
    const r = await db().query<{ id: string; tenant_id: string; external_ref: string }>(
      `SELECT id, tenant_id, external_ref FROM shipments
       WHERE status = $1 AND updated_at < now() - $2::interval ORDER BY updated_at LIMIT 50`,
      [rule.status, rule.interval],
    );
    const total = await db().query<{ n: string }>(
      'SELECT count(*) AS n FROM shipments WHERE status = $1 AND updated_at < now() - $2::interval',
      [rule.status, rule.interval],
    );
    const n = Number(total.rows[0]?.n ?? 0);
    counts[rule.status] = n;
    if (n > 0)
      await alert('stale_shipments', `${n} 筆託運單${rule.label}`, {
        status: rule.status,
        sample: r.rows.slice(0, 10).map((x) => x.id),
      });
  }
  return counts;
}

/**
 * cvs-expiry-check：超商到店後接近取貨期限仍未取，提前發 shipment.cvs_pickup_expiring 給上游。
 * 每筆只發一次（以 outbox 是否已有同類事件判斷），可重入。
 */
export async function cvsExpiryCheck(): Promise<number> {
  const c = config();
  const warnAfterDays = Math.max(c.CVS_PICKUP_DAYS - c.CVS_EXPIRY_WARN_DAYS, 0);
  const r = await db().query<ShipmentRow & { arrived_at: Date }>(
    `SELECT s.*, a.arrived_at FROM shipments s
     JOIN LATERAL (
       SELECT max(occurred_at) AS arrived_at FROM tracking_events
       WHERE shipment_id = s.id AND status = 'ARRIVED_AT_STORE'
     ) a ON true
     WHERE s.status = 'ARRIVED_AT_STORE'
       AND COALESCE(a.arrived_at, s.updated_at) < now() - make_interval(days => $1)
       AND NOT EXISTS (
         SELECT 1 FROM outbox_events o
         WHERE o.event_type = 'shipment.cvs_pickup_expiring' AND o.payload->'data'->>'shipment_id' = s.id::text
       )
     LIMIT 500`,
    [warnAfterDays],
  );
  for (const s of r.rows) {
    const arrived = s.arrived_at ?? s.updated_at;
    const deadline = new Date(arrived.getTime() + c.CVS_PICKUP_DAYS * 86400_000);
    await tx((client) =>
      insertOutboxEvent(
        client,
        s.tenant_id,
        'shipment.cvs_pickup_expiring',
        shipmentEventData(s, { arrived_at: toTaipeiIso(arrived), pickup_deadline: toTaipeiIso(deadline) }),
      ),
    );
  }
  return r.rows.length;
}
