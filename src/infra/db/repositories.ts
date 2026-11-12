import type { CarrierAccount } from '../../carriers/carrier.interface.js';
import type { SenderInfo, ShipmentRow, TrackingEventRow } from '../../domain/shipment/types.js';
import { secretBox } from '../crypto/box.js';
import { randomToken, sha256 } from '../crypto/secrets.js';
import { db, type Queryable } from './pool.js';

// ---------- tenants ----------

export interface TenantRow {
  id: string;
  name: string;
  webhook_url: string | null;
  webhook_secret: string;
  store_map_return_origins: string[];
  created_at: Date;
}

export async function getTenant(id: string, q: Queryable = db()): Promise<TenantRow | null> {
  const r = await q.query<TenantRow>('SELECT * FROM tenants WHERE id = $1', [id]);
  return r.rows[0] ?? null;
}

export async function listTenants(q: Queryable = db()): Promise<TenantRow[]> {
  return (await q.query<TenantRow>('SELECT * FROM tenants ORDER BY created_at')).rows;
}

export async function createTenant(
  input: { name: string; webhook_url?: string | null; store_map_return_origins?: string[] },
  q: Queryable = db(),
): Promise<TenantRow> {
  const r = await q.query<TenantRow>(
    `INSERT INTO tenants (name, webhook_url, webhook_secret, store_map_return_origins)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [input.name, input.webhook_url ?? null, `whsec_${randomToken(24)}`, input.store_map_return_origins ?? []],
  );
  return r.rows[0]!;
}

export async function updateTenant(
  id: string,
  input: { name?: string; webhook_url?: string | null; store_map_return_origins?: string[]; rotate_secret?: boolean },
  q: Queryable = db(),
): Promise<TenantRow | null> {
  const r = await q.query<TenantRow>(
    `UPDATE tenants SET
       name = COALESCE($2, name),
       webhook_url = CASE WHEN $3::boolean THEN $4 ELSE webhook_url END,
       store_map_return_origins = COALESCE($5, store_map_return_origins),
       webhook_secret = CASE WHEN $6::boolean THEN $7 ELSE webhook_secret END
     WHERE id = $1 RETURNING *`,
    [
      id,
      input.name ?? null,
      input.webhook_url !== undefined,
      input.webhook_url ?? null,
      input.store_map_return_origins ?? null,
      Boolean(input.rotate_secret),
      `whsec_${randomToken(24)}`,
    ],
  );
  return r.rows[0] ?? null;
}

// ---------- api keys ----------

export interface ApiKeyRow {
  id: string;
  tenant_id: string;
  key_prefix: string;
  label: string | null;
  revoked_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
}

/** 回傳明文 key（只在建立時出現一次），DB 只存 sha256 */
export async function createApiKey(tenantId: string, label: string | null, q: Queryable = db()) {
  const plain = `lsk_${randomToken(32)}`;
  const r = await q.query<ApiKeyRow>(
    `INSERT INTO api_keys (tenant_id, key_hash, key_prefix, label) VALUES ($1, $2, $3, $4)
     RETURNING id, tenant_id, key_prefix, label, revoked_at, last_used_at, created_at`,
    [tenantId, sha256(plain), plain.slice(0, 10), label],
  );
  return { key: plain, row: r.rows[0]! };
}

export async function findApiKey(plain: string): Promise<ApiKeyRow | null> {
  const r = await db().query<ApiKeyRow>(
    `UPDATE api_keys SET last_used_at = now()
     WHERE key_hash = $1 AND revoked_at IS NULL
     RETURNING id, tenant_id, key_prefix, label, revoked_at, last_used_at, created_at`,
    [sha256(plain)],
  );
  return r.rows[0] ?? null;
}

export async function listApiKeys(tenantId: string): Promise<ApiKeyRow[]> {
  return (
    await db().query<ApiKeyRow>(
      `SELECT id, tenant_id, key_prefix, label, revoked_at, last_used_at, created_at
       FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    )
  ).rows;
}

export async function revokeApiKey(tenantId: string, id: string): Promise<boolean> {
  const r = await db().query(
    'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL',
    [id, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}

// ---------- carrier accounts ----------

interface CarrierAccountDbRow {
  id: string;
  tenant_id: string;
  carrier_code: string;
  name: string;
  credentials_enc: Buffer;
  is_sandbox: boolean;
  is_default: boolean;
  sender_info: SenderInfo;
  created_at: Date;
}

export type CarrierAccountSummary = Omit<CarrierAccountDbRow, 'credentials_enc'> & { credential_keys: string[] };

function decryptAccount(row: CarrierAccountDbRow): CarrierAccount {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    carrier_code: row.carrier_code,
    name: row.name,
    credentials: JSON.parse(secretBox().decrypt(row.credentials_enc)),
    is_sandbox: row.is_sandbox,
    is_default: row.is_default,
    sender_info: row.sender_info,
  };
}

export async function getCarrierAccount(id: string, q: Queryable = db()): Promise<CarrierAccount | null> {
  const r = await q.query<CarrierAccountDbRow>('SELECT * FROM carrier_accounts WHERE id = $1', [id]);
  return r.rows[0] ? decryptAccount(r.rows[0]) : null;
}

export async function listCarrierAccountsDecrypted(tenantId: string): Promise<CarrierAccount[]> {
  const r = await db().query<CarrierAccountDbRow>(
    'SELECT * FROM carrier_accounts WHERE tenant_id = $1 ORDER BY is_default DESC, created_at',
    [tenantId],
  );
  return r.rows.map(decryptAccount);
}

/** 後台列表：不解出金鑰值，只列欄位名稱 */
export async function listCarrierAccounts(tenantId?: string): Promise<CarrierAccountSummary[]> {
  const r = await db().query<CarrierAccountDbRow>(
    `SELECT * FROM carrier_accounts WHERE ($1::uuid IS NULL OR tenant_id = $1) ORDER BY tenant_id, created_at`,
    [tenantId ?? null],
  );
  return r.rows.map(({ credentials_enc, ...rest }) => {
    let keys: string[] = [];
    try {
      keys = Object.keys(JSON.parse(secretBox().decrypt(credentials_enc)));
    } catch {
      keys = ['<無法解密>'];
    }
    return { ...rest, credential_keys: keys };
  });
}

export async function createCarrierAccount(
  input: {
    tenant_id: string;
    carrier_code: string;
    name: string;
    credentials: Record<string, string>;
    is_sandbox: boolean;
    is_default: boolean;
    sender_info: SenderInfo;
  },
  q: Queryable,
): Promise<string> {
  if (input.is_default)
    await q.query('UPDATE carrier_accounts SET is_default = false WHERE tenant_id = $1 AND carrier_code = $2', [
      input.tenant_id,
      input.carrier_code,
    ]);
  const r = await q.query<{ id: string }>(
    `INSERT INTO carrier_accounts (tenant_id, carrier_code, name, credentials_enc, is_sandbox, is_default, sender_info)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      input.tenant_id,
      input.carrier_code,
      input.name,
      secretBox().encrypt(JSON.stringify(input.credentials)),
      input.is_sandbox,
      input.is_default,
      input.sender_info,
    ],
  );
  return r.rows[0]!.id;
}

// ---------- shipments ----------

export async function getShipment(id: string, q: Queryable = db()): Promise<ShipmentRow | null> {
  const r = await q.query<ShipmentRow>('SELECT * FROM shipments WHERE id = $1', [id]);
  return r.rows[0] ?? null;
}

export async function getShipmentForTenant(tenantId: string, id: string): Promise<ShipmentRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await db().query<ShipmentRow>('SELECT * FROM shipments WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  return r.rows[0] ?? null;
}

export async function lockShipment(q: Queryable, id: string): Promise<ShipmentRow | null> {
  const r = await q.query<ShipmentRow>('SELECT * FROM shipments WHERE id = $1 FOR UPDATE', [id]);
  return r.rows[0] ?? null;
}

export async function findShipmentByCarrierRef(
  carrierCode: string,
  ref: { carrierShipmentId?: string; trackingNumber?: string; shipmentRef?: string },
): Promise<ShipmentRow | null> {
  const r = await db().query<ShipmentRow>(
    `SELECT * FROM shipments
     WHERE carrier_code = $1 AND (
       ($2::text IS NOT NULL AND carrier_shipment_id = $2) OR
       ($3::text IS NOT NULL AND tracking_number = $3) OR
       ($4::text IS NOT NULL AND carrier_payload->>'merchant_trade_no' = $4)
     )
     ORDER BY created_at DESC LIMIT 1`,
    [carrierCode, ref.carrierShipmentId ?? null, ref.trackingNumber ?? null, ref.shipmentRef ?? null],
  );
  return r.rows[0] ?? null;
}

export interface ShipmentFilter {
  tenantId?: string;
  externalRef?: string;
  status?: string[];
  carrierCode?: string;
  q?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
}

/** cursor = base64url(created_at|id)，依 created_at DESC, id DESC 分頁 */
export function encodeCursor(row: { created_at: Date; id: string }): string {
  return Buffer.from(`${row.created_at.toISOString()}|${row.id}`).toString('base64url');
}

function decodeCursor(c: string): { at: Date; id: string } | null {
  const [at, id] = Buffer.from(c, 'base64url').toString().split('|');
  if (!at || !id || Number.isNaN(Date.parse(at))) return null;
  return { at: new Date(at), id };
}

export async function listShipments(f: ShipmentFilter): Promise<{ rows: ShipmentRow[]; nextCursor: string | null }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (f.tenantId) add('tenant_id = ?', f.tenantId);
  if (f.externalRef) add('external_ref = ?', f.externalRef);
  if (f.status?.length) add('status = ANY(?)', f.status);
  if (f.carrierCode) add('carrier_code = ?', f.carrierCode);
  if (f.from) add('created_at >= ?', f.from);
  if (f.to) add('created_at < ?', f.to);
  if (f.q) {
    params.push(f.q);
    const p = `$${params.length}`;
    where.push(`(external_ref = ${p} OR tracking_number = ${p} OR id::text = ${p} OR carrier_shipment_id = ${p})`);
  }
  if (f.cursor) {
    const c = decodeCursor(f.cursor);
    if (c) {
      params.push(c.at, c.id);
      where.push(`(created_at, id) < ($${params.length - 1}, $${params.length})`);
    }
  }
  params.push(f.limit + 1);
  const sql = `SELECT * FROM shipments ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;
  const rows = (await db().query<ShipmentRow>(sql, params)).rows;
  const hasMore = rows.length > f.limit;
  const page = hasMore ? rows.slice(0, f.limit) : rows;
  return { rows: page, nextCursor: hasMore ? encodeCursor(page[page.length - 1]!) : null };
}

export async function listTrackingEvents(shipmentId: string): Promise<TrackingEventRow[]> {
  return (
    await db().query<TrackingEventRow>(
      'SELECT * FROM tracking_events WHERE shipment_id = $1 ORDER BY occurred_at, id',
      [shipmentId],
    )
  ).rows;
}

export async function getPackage(shipmentId: string) {
  const r = await db().query(
    'SELECT weight_g, length_cm, width_cm, height_cm, size_code FROM packages WHERE shipment_id = $1 LIMIT 1',
    [shipmentId],
  );
  return r.rows[0] ?? null;
}

// ---------- audit ----------

export async function audit(
  q: Queryable,
  entry: { tenant_id?: string | null; actor: string; action: string; target_id?: string | null; detail?: unknown },
): Promise<void> {
  await q.query('INSERT INTO audit_logs (tenant_id, actor, action, target_id, detail) VALUES ($1, $2, $3, $4, $5)', [
    entry.tenant_id ?? null,
    entry.actor,
    entry.action,
    entry.target_id ?? null,
    entry.detail === undefined ? null : JSON.stringify(entry.detail),
  ]);
}
