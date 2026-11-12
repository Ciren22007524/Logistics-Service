import { carriers } from '../carriers/carrier.registry.js';
import { toCarrierError } from '../carriers/errors.js';
import { transition } from '../domain/shipment/shipment.service.js';
import { tx } from '../infra/db/pool.js';
import { getCarrierAccount, getShipment, lockShipment } from '../infra/db/repositories.js';
import { putObject } from '../infra/storage/s3.js';
import { logger } from '../lib/logger.js';
import { insertOutboxEvent, shipmentEventData } from '../outbox/outbox.js';

export const labelKey = (s: { tenant_id: string; id: string }, ext: string) => `labels/${s.tenant_id}/${s.id}.${ext}`;

/**
 * fetch-label：下載標籤存 S3，LABEL_PENDING → READY_TO_SHIP，發 shipment.label_ready。
 * 可重入：已有 label_url 且非強制就跳過；S3 key 固定，重跑只會覆蓋同一個檔案。
 */
export async function fetchLabel(shipmentId: string, force = false): Promise<'stored' | 'skipped'> {
  const s = await getShipment(shipmentId);
  if (!s) return 'skipped';
  if (!s.tracking_number && !s.carrier_shipment_id) return 'skipped';
  if (['CANCELLED', 'FAILED'].includes(s.status)) return 'skipped';
  if (s.label_url && !force) return 'skipped';

  const adapter = carriers().get(s.carrier_code);
  const account = await getCarrierAccount(s.carrier_account_id);
  if (!account) throw new Error('carrier account missing');

  let file;
  try {
    file = await adapter.getLabel(s, account);
  } catch (raw) {
    const err = toCarrierError(raw);
    // ValidationError（例如物流商尚未產生標籤）同樣交給 BullMQ 退避重試；最後一次失敗會告警
    throw Object.assign(new Error(`[${err.kind}] ${err.message}`), { carrierKind: err.kind });
  }
  const key = labelKey(s, file.extension);
  await putObject(key, file.content, file.contentType);

  await tx(async (c) => {
    const locked = await lockShipment(c, s.id);
    if (!locked) return;
    const r = await c.query(
      'UPDATE shipments SET label_url = $2, label_content_type = $3, updated_at = now() WHERE id = $1 RETURNING *',
      [s.id, key, file.contentType],
    );
    let updated = r.rows[0];
    const wasFirst = !locked.label_url;
    if (locked.status === 'LABEL_PENDING')
      updated = (await transition(c, updated, 'READY_TO_SHIP', { reason: 'label stored' })) ?? updated;
    if (wasFirst)
      await insertOutboxEvent(
        c,
        s.tenant_id,
        'shipment.label_ready',
        shipmentEventData(updated, { label_content_type: file.contentType }),
      );
  });
  logger.info({ shipment_id: s.id, content_type: file.contentType }, 'label stored');
  return 'stored';
}
