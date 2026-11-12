import type { CvsStore } from '../shipment/types.js';
import type { RawCallback } from '../../carriers/carrier.interface.js';
import { carriers } from '../../carriers/carrier.registry.js';
import { config } from '../../config.js';
import { randomToken } from '../../infra/crypto/secrets.js';
import { db } from '../../infra/db/pool.js';
import { getCarrierAccount, getTenant, listCarrierAccountsDecrypted } from '../../infra/db/repositories.js';
import { redis } from '../../infra/redis.js';
import { HttpError, badRequest } from '../../lib/errors.js';
import { pickHeaders } from '../tracking/callbacks.js';

/**
 * 超商電子地圖選店流程：
 * 1. 上游 GET /v1/cvs/store-map → 平台建立一次性 token，回傳 /cvs/store-map/{token}
 * 2. 使用者瀏覽器開啟該網址 → 平台導向（或自動 POST）物流商地圖
 * 3. 物流商把選擇結果送回 /cvs/store-selection/{carrier} → 平台驗 token
 * 4. 平台 303 導回上游 return_url，帶 store_id / store_name / store_address / sub_type / carrier_code
 */
interface StoreMapSession {
  tenantId: string;
  accountId: string;
  carrierCode: string;
  subType: string;
  returnUrl: string;
  isCollection: boolean;
  device: 'PC' | 'MOBILE';
}

const TTL = 1800;

export async function createStoreMapSession(input: {
  tenantId: string;
  carrier?: string;
  carrierAccountId?: string;
  subType: string;
  returnUrl: string;
  isCollection?: boolean;
  device?: 'PC' | 'MOBILE';
  /** 後台呼叫時允許導回後台 */
  extraAllowedOrigins?: string[];
}): Promise<{ url: string; expires_in: number }> {
  let returnUrl: URL;
  try {
    returnUrl = new URL(input.returnUrl);
  } catch {
    throw badRequest('return_url 格式錯誤');
  }
  const tenant = await getTenant(input.tenantId);
  if (!tenant) throw badRequest('tenant not found');
  const allowed = new Set([...tenant.store_map_return_origins, ...(input.extraAllowedOrigins ?? [])]);
  if (!allowed.has(returnUrl.origin))
    throw new HttpError(422, 'return_url_not_allowed', `return_url 來源 ${returnUrl.origin} 未登記於租戶 store_map_return_origins`);

  let account;
  if (input.carrierAccountId) {
    account = await getCarrierAccount(input.carrierAccountId);
    if (!account || account.tenant_id !== input.tenantId) throw badRequest('carrier_account_id 不存在');
  } else {
    if (!input.carrier) throw badRequest('需提供 carrier 或 carrier_account_id');
    const accounts = await listCarrierAccountsDecrypted(input.tenantId);
    account = accounts.find((a) => a.carrier_code === input.carrier!.toUpperCase() && a.is_default) ??
      accounts.find((a) => a.carrier_code === input.carrier!.toUpperCase());
    if (!account) throw badRequest(`租戶沒有 ${input.carrier} 帳號`);
  }
  const adapter = carriers().find(account.carrier_code);
  if (!adapter?.getStoreMapRequest || !adapter.capabilities.storeMap)
    throw new HttpError(422, 'store_map_unsupported', `${account.carrier_code} 不支援電子地圖`);
  if (adapter.limits.cvsSubTypes && !adapter.limits.cvsSubTypes.includes(input.subType))
    throw badRequest(`${account.carrier_code} 不支援 sub_type=${input.subType}`, { allowed: adapter.limits.cvsSubTypes });

  const token = randomToken(24);
  const session: StoreMapSession = {
    tenantId: input.tenantId,
    accountId: account.id,
    carrierCode: account.carrier_code,
    subType: input.subType,
    returnUrl: returnUrl.toString(),
    isCollection: Boolean(input.isCollection),
    device: input.device ?? 'PC',
  };
  await redis().set(`storemap:${token}`, JSON.stringify(session), 'EX', TTL);
  return { url: new URL(`/cvs/store-map/${token}`, config().PUBLIC_BASE_URL).toString(), expires_in: TTL };
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** 瀏覽器開啟 /cvs/store-map/{token}：GET 型直接導向；POST 型輸出自動送出的表單 */
export async function renderStoreMap(token: string): Promise<{ redirect: string } | { html: string }> {
  const raw = await redis().get(`storemap:${token}`);
  if (!raw) throw new HttpError(404, 'expired', '選店連結已失效，請重新操作');
  const s = JSON.parse(raw) as StoreMapSession;
  const account = await getCarrierAccount(s.accountId);
  const adapter = carriers().get(s.carrierCode);
  if (!account || !adapter.getStoreMapRequest) throw new HttpError(404, 'expired', '選店設定不存在');
  const req = await adapter.getStoreMapRequest(
    {
      subType: s.subType,
      replyUrl: new URL(`/cvs/store-selection/${s.carrierCode}`, config().PUBLIC_BASE_URL).toString(),
      state: token,
      isCollection: s.isCollection,
      device: s.device,
    },
    account,
  );
  if (req.method === 'GET') return { redirect: req.url };
  const inputs = Object.entries(req.fields)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join('');
  return {
    html: `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>前往門市地圖</title></head>
<body><form id="f" method="post" action="${escapeHtml(req.url)}">${inputs}
<noscript><button type="submit">前往選擇門市</button></noscript></form>
<script>document.getElementById('f').submit()</script></body></html>`,
  };
}

/** 物流商送回選店結果 → 303 導回上游 */
export async function handleStoreSelection(carrierCode: string, req: RawCallback): Promise<string> {
  const code = carrierCode.toUpperCase();
  const adapter = carriers().find(code);
  const log = await db().query<{ id: string }>(
    `INSERT INTO carrier_callbacks (carrier_code, kind, headers, body) VALUES ($1, 'STORE_SELECTION', $2, $3) RETURNING id`,
    [code, JSON.stringify(pickHeaders(req.headers)), req.body],
  );
  const logId = log.rows[0]!.id;
  const fail = async (msg: string): Promise<never> => {
    await db().query('UPDATE carrier_callbacks SET error = $2, processed_at = now() WHERE id = $1', [logId, msg]);
    throw new HttpError(400, 'store_selection_failed', msg);
  };
  if (!adapter?.parseStoreSelection) return fail('unsupported carrier');
  let parsed: { state: string; store: CvsStore };
  try {
    parsed = adapter.parseStoreSelection(req);
  } catch (err) {
    return fail((err as Error).message);
  }
  // token 一次性
  const raw = await redis().getdel(`storemap:${parsed.state}`);
  if (!raw) return fail('選店連結已失效');
  const s = JSON.parse(raw) as StoreMapSession;
  if (s.carrierCode !== code) return fail('物流商不一致');
  if (parsed.store.sub_type !== s.subType) return fail('門市類型與選店請求不一致');
  await db().query(
    'UPDATE carrier_callbacks SET verified = true, processed_at = now(), carrier_account_id = $2 WHERE id = $1',
    [logId, s.accountId],
  );
  const url = new URL(s.returnUrl);
  url.searchParams.set('carrier_code', code);
  url.searchParams.set('carrier_account_id', s.accountId);
  url.searchParams.set('sub_type', parsed.store.sub_type);
  url.searchParams.set('store_id', parsed.store.store_id);
  if (parsed.store.store_name) url.searchParams.set('store_name', parsed.store.store_name);
  if (parsed.store.store_address) url.searchParams.set('store_address', parsed.store.store_address);
  return url.toString();
}
