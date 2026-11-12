import type { CarrierAccount, RawCallback } from '../../carriers/carrier.interface.js';
import { carriers } from '../../carriers/carrier.registry.js';
import { db } from '../../infra/db/pool.js';
import { findShipmentByCarrierRef, getCarrierAccount } from '../../infra/db/repositories.js';
import { enqueueCallback } from '../../infra/queue/queues.js';
import { logger } from '../../lib/logger.js';
import { ingestTrackingEvents } from '../shipment/shipment.service.js';

const KEEP_HEADERS = ['content-type', 'user-agent', 'x-forwarded-for', 'x-real-ip', 'x-mock-signature'];

export function pickHeaders(h: RawCallback['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of KEEP_HEADERS) {
    const v = h[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

export interface CallbackResponse {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * 物流商回調入口（規格 7.3）：
 * 1. 原文寫入 carrier_callbacks  2. 驗簽，失敗記錄後回應錯誤
 * 3. 丟進佇列非同步處理         4. 依物流商要求格式立刻回應成功
 */
export async function receiveCallback(
  carrierCode: string,
  accountId: string | undefined,
  req: RawCallback,
): Promise<CallbackResponse> {
  const code = carrierCode.toUpperCase();
  const ins = await db().query<{ id: string }>(
    'INSERT INTO carrier_callbacks (carrier_code, carrier_account_id, headers, body) VALUES ($1, $2, $3, $4) RETURNING id',
    [code, accountId && isUuid(accountId) ? accountId : null, JSON.stringify(pickHeaders(req.headers)), req.body],
  );
  const callbackId = ins.rows[0]!.id;
  const adapter = carriers().find(code);
  if (!adapter) {
    await markCallback(callbackId, { error: 'unknown carrier', verified: false });
    return { status: 404, body: 'unknown carrier' };
  }

  const fail = async (error: string): Promise<CallbackResponse> => {
    await markCallback(callbackId, { error, verified: false, processed: true });
    logger.warn({ callback_id: callbackId, carrier: code, error }, 'callback rejected');
    return adapter.callbackAck('ERROR');
  };

  let parsed;
  try {
    parsed = adapter.parseCallback(req);
  } catch (err) {
    return fail(`parse: ${(err as Error).message}`);
  }

  // 帳號：優先用網址上的 account id（我們給物流商的 ServerReplyURL 都帶），否則從託運單反查
  let account: CarrierAccount | null = null;
  let shipmentId: string | null = null;
  if (accountId) {
    if (!isUuid(accountId)) return fail('invalid account id');
    account = await getCarrierAccount(accountId);
    if (!account || account.carrier_code !== code) return fail('account not found');
  } else {
    const shipment = await findShipmentByCarrierRef(code, parsed);
    if (!shipment) return fail('shipment not found');
    shipmentId = shipment.id;
    account = await getCarrierAccount(shipment.carrier_account_id);
    if (!account) return fail('account not found');
  }

  let verified = false;
  try {
    verified = adapter.verifyCallback(req, account);
  } catch (err) {
    return fail(`verify: ${(err as Error).message}`);
  }
  if (!verified) return fail('signature verification failed');

  await db().query(
    'UPDATE carrier_callbacks SET verified = true, carrier_account_id = $2, shipment_id = $3 WHERE id = $1',
    [callbackId, account.id, shipmentId],
  );
  try {
    await enqueueCallback(callbackId);
  } catch (err) {
    // 佇列掛掉時：原文已存，回錯誤讓物流商重送
    logger.error({ err, callback_id: callbackId }, 'enqueue callback failed');
    return adapter.callbackAck('ERROR');
  }
  return adapter.callbackAck('OK');
}

async function markCallback(
  id: string,
  m: { error?: string | null; verified?: boolean; processed?: boolean; shipmentId?: string },
) {
  await db().query(
    `UPDATE carrier_callbacks SET
       error = COALESCE($2, error),
       verified = COALESCE($3, verified),
       processed_at = CASE WHEN $4::boolean THEN now() ELSE processed_at END,
       shipment_id = COALESCE($5, shipment_id)
     WHERE id = $1`,
    [id, m.error ?? null, m.verified ?? null, Boolean(m.processed), m.shipmentId ?? null],
  );
}

interface CallbackRow {
  id: string;
  carrier_code: string;
  carrier_account_id: string | null;
  headers: Record<string, string>;
  body: string;
  verified: boolean | null;
  processed_at: Date | null;
}

/**
 * process-callback worker：解析 → 寫 tracking_events → 推進狀態 → 寫 outbox。
 * 可重入：processed_at 已有值就跳過；事件唯一鍵擋重複。
 * 找不到託運單時丟錯讓 BullMQ 退避重試（回調可能比建單結果先到）。
 */
export async function processCallback(callbackId: string): Promise<'processed' | 'skipped'> {
  const r = await db().query<CallbackRow>('SELECT * FROM carrier_callbacks WHERE id = $1', [callbackId]);
  const row = r.rows[0];
  if (!row || row.processed_at || row.verified !== true) return 'skipped';
  const adapter = carriers().get(row.carrier_code);
  const raw: RawCallback = {
    headers: row.headers ?? {},
    query: {},
    contentType: row.headers?.['content-type'] ?? '',
    body: row.body,
  };
  const parsed = adapter.parseCallback(raw);
  const shipment = await findShipmentByCarrierRef(row.carrier_code, parsed);
  if (!shipment) {
    await markCallback(callbackId, { error: 'shipment not found (will retry)' });
    throw new Error(`callback ${callbackId}: shipment not found`);
  }
  if (row.carrier_account_id && shipment.carrier_account_id !== row.carrier_account_id) {
    await markCallback(callbackId, { error: 'shipment belongs to another account', processed: true });
    return 'skipped';
  }
  const result = await ingestTrackingEvents(shipment.id, parsed.events, 'CALLBACK');
  await markCallback(callbackId, { processed: true, error: null, shipmentId: shipment.id });
  await db().query('UPDATE carrier_callbacks SET error = NULL WHERE id = $1', [callbackId]);
  logger.info({ callback_id: callbackId, shipment_id: shipment.id, ...result }, 'callback processed');
  return 'processed';
}

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
