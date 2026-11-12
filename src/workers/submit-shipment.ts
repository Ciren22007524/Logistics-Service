import { carriers } from '../carriers/carrier.registry.js';
import { toCarrierError } from '../carriers/errors.js';
import { config } from '../config.js';
import { assertAccountAllowed, callbackUrlFor, transition, withShipmentLock } from '../domain/shipment/shipment.service.js';
import { toCarrierInput } from '../domain/shipment/validation.js';
import { db, tx } from '../infra/db/pool.js';
import { getCarrierAccount, getPackage, getShipment, lockShipment } from '../infra/db/repositories.js';
import { enqueueFetchLabel, enqueueSubmit } from '../infra/queue/queues.js';
import { alert } from '../lib/alert.js';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/** 重試退避：30s, 1m, 2m, 4m, 8m…（上限 30 分鐘） */
export const submitBackoffMs = (attempt: number) => Math.min(30_000 * 2 ** (attempt - 1), 30 * 60_000);

const UNKNOWN_MAX_ATTEMPTS = 3;

export type SubmitOutcome = 'submitted' | 'skipped' | 'retry_scheduled' | 'failed' | 'busy';

/**
 * submit-shipment：呼叫 adapter 建單 → 取號 → LABEL_PENDING，並排 fetch-label。
 * 可重入：不是 CREATED 就跳過；已有 tracking_number 就不再送物流商（規格 9.1）。
 */
export async function submitShipment(shipmentId: string): Promise<SubmitOutcome> {
  try {
    return await withShipmentLock(shipmentId, () => doSubmit(shipmentId));
  } catch (err) {
    if (err instanceof HttpError && err.code === 'busy') return 'busy';
    throw err;
  }
}

async function doSubmit(shipmentId: string): Promise<SubmitOutcome> {
  const s = await getShipment(shipmentId);
  if (!s || s.status !== 'CREATED') return 'skipped';

  if (s.tracking_number) {
    await tx(async (c) => {
      const locked = await lockShipment(c, s.id);
      if (locked?.status === 'CREATED') await transition(c, locked, 'LABEL_PENDING', { reason: 'already has tracking number' });
    });
    await enqueueFetchLabel(s.id);
    return 'skipped';
  }

  const adapter = carriers().get(s.carrier_code);
  const account = await getCarrierAccount(s.carrier_account_id);
  if (!account) throw new Error(`carrier account ${s.carrier_account_id} missing`);

  const attempt = s.attempt_count + 1;
  await db().query('UPDATE shipments SET attempt_count = $2, updated_at = now() WHERE id = $1', [s.id, attempt]);

  try {
    assertAccountAllowed(account);
    const pkg = await getPackage(s.id);
    const input = toCarrierInput(
      s.id,
      {
        external_ref: s.external_ref,
        service_type: s.service_type,
        temperature: s.temperature,
        recipient: s.recipient,
        cvs_store: s.cvs_store,
        package: pkg,
        cod_amount: s.cod_amount,
        declared_value: s.declared_value,
        items_summary: s.items_summary ?? '',
        preferred_time_slot: s.preferred_time_slot,
        scheduled_pickup_at: s.scheduled_pickup_at?.toISOString() ?? null,
        metadata: s.metadata,
      },
      account.sender_info,
      callbackUrlFor(account),
    );
    const result = await adapter.createShipment(input, account);
    await tx(async (c) => {
      const locked = await lockShipment(c, s.id);
      if (!locked || locked.status !== 'CREATED') return;
      await transition(c, locked, 'LABEL_PENDING', {
        set: {
          tracking_number: result.trackingNumber,
          carrier_shipment_id: result.carrierShipmentId,
          carrier_payload: result.raw,
        },
        error: null,
        reason: 'submitted to carrier',
      });
    });
    if (result.labelAvailable) await enqueueFetchLabel(s.id);
    logger.info({ shipment_id: s.id, carrier: s.carrier_code, attempt }, 'shipment submitted');
    return 'submitted';
  } catch (raw) {
    const err =
      raw instanceof HttpError && raw.code === 'production_account_forbidden'
        ? Object.assign(new Error(raw.message), { kind: 'AUTH' as const })
        : toCarrierError(raw);
    const kind = 'kind' in err ? err.kind : 'UNKNOWN';
    const message = `[${kind}] ${err.message}`;
    const maxAttempts = kind === 'UNKNOWN' ? UNKNOWN_MAX_ATTEMPTS : config().SUBMIT_MAX_ATTEMPTS;

    if ((kind === 'RETRYABLE' || kind === 'UNKNOWN') && attempt < maxAttempts) {
      await db().query('UPDATE shipments SET last_error = $2 WHERE id = $1', [s.id, message]);
      await enqueueSubmit(s.id, submitBackoffMs(attempt), attempt);
      logger.warn({ shipment_id: s.id, attempt, kind }, 'submit failed, retry scheduled');
      return 'retry_scheduled';
    }

    await tx(async (c) => {
      const locked = await lockShipment(c, s.id);
      if (locked) await transition(c, locked, 'FAILED', { error: message, reason: kind });
    });
    if (kind === 'AUTH' || kind === 'UNKNOWN' || kind === 'RETRYABLE')
      await alert('submit_failed', `託運單建單失敗：${message}`, { shipment_id: s.id, carrier: s.carrier_code, attempt });
    return 'failed';
  }
}
