import { z } from 'zod';
import type { CarrierAdapter, CreateShipmentInput } from '../../carriers/carrier.interface.js';
import { SERVICE_TYPES, TEMPERATURES } from './types.js';

/** 手機：09 開頭 10 碼（允許輸入 0912-345-678、+886912345678） */
export function normalizeMobile(raw: string): string | null {
  let s = raw.replace(/[\s\-()]/g, '');
  if (s.startsWith('+886')) s = `0${s.slice(4)}`;
  else if (s.startsWith('886') && s.length === 12) s = `0${s.slice(3)}`;
  return /^09\d{8}$/.test(s) ? s : null;
}

/** 市話：區碼 02~089 + 6~8 碼，可帶分機 #123 */
export function normalizeLandline(raw: string): string | null {
  const s = raw.replace(/[\s\-()]/g, '');
  const m = s.match(/^(0[2-8]\d{0,2})(\d{6,8})(#\d{1,6})?$/);
  if (!m) return null;
  const digits = m[1]!.length + m[2]!.length;
  return digits >= 9 && digits <= 10 ? s : null;
}

export function normalizePhone(raw: string): string | null {
  return normalizeMobile(raw) ?? normalizeLandline(raw);
}

const CITIES = [
  '台北市', '臺北市', '新北市', '桃園市', '台中市', '臺中市', '台南市', '臺南市', '高雄市', '基隆市',
  '新竹市', '嘉義市', '新竹縣', '苗栗縣', '彰化縣', '南投縣', '雲林縣', '嘉義縣', '屏東縣', '宜蘭縣',
  '花蓮縣', '台東縣', '臺東縣', '澎湖縣', '金門縣', '連江縣',
];

/** 地址至少要有縣市 */
export function hasCity(address: string): boolean {
  const s = address.replace(/^\d{3,6}/, '').trim();
  return CITIES.some((c) => s.startsWith(c));
}

/** 從地址前綴抽出郵遞區號（3 碼、3+2 或 3+3 碼） */
export function extractZip(address: string): { zip: string | null; rest: string } {
  const m = address.trim().match(/^(\d{3}(?:\d{2,3})?)\s*(.*)$/);
  return m ? { zip: m[1]!, rest: m[2]! } : { zip: null, rest: address.trim() };
}

/** 品名：移除控制字元與物流商常拒收的符號，截斷到限制長度 */
export function sanitizeItems(s: string, maxLength: number): string {
  const cleaned = s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>"'`\\|^@#$%&*+=[\]{}~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return [...cleaned].slice(0, maxLength).join('');
}

const recipientSchema = z.object({
  name: z.string().trim().min(1).max(50),
  phone: z.string().trim().min(8).max(20),
  email: z.string().email().optional(),
  zip: z.string().trim().regex(/^\d{3}(\d{2,3})?$/, '郵遞區號需為 3、5 或 6 碼').optional(),
  address: z.string().trim().max(200).optional(),
});

const cvsStoreSchema = z.object({
  sub_type: z.string().trim().min(1).max(30),
  store_id: z.string().trim().min(1).max(20),
  store_name: z.string().max(100).optional(),
  store_address: z.string().max(200).optional(),
  carrier_code: z.string().optional(),
});

const intOrNull = z.number().int().nonnegative().nullable().optional();

export const createShipmentSchema = z
  .object({
    external_ref: z.string().trim().min(1).max(100),
    carrier_account_id: z.string().uuid().nullable().optional(),
    service_type: z.enum(SERVICE_TYPES),
    temperature: z.enum(TEMPERATURES).default('NORMAL'),
    recipient: recipientSchema,
    cvs_store: cvsStoreSchema.nullable().optional(),
    package: z
      .object({
        weight_g: intOrNull,
        length_cm: intOrNull,
        width_cm: intOrNull,
        height_cm: intOrNull,
        size_code: z.string().max(20).nullable().optional(),
      })
      .nullable()
      .optional(),
    cod_amount: z.number().int().positive().nullable().optional(),
    declared_value: z.number().int().nonnegative().nullable().optional(),
    items_summary: z.string().max(500).default(''),
    scheduled_pickup_at: z.string().datetime({ offset: true }).nullable().optional(),
    preferred_time_slot: z.string().max(30).nullable().optional(),
    metadata: z.record(z.unknown()).default({}),
  })
  .strict();

export type CreateShipmentRequest = z.infer<typeof createShipmentSchema>;

export interface NormalizedShipment extends CreateShipmentRequest {
  items_summary: string;
}

/**
 * 建單前先擋（規格 9.2）。回傳 field → message；空物件代表通過。
 * 會就地正規化電話、郵遞區號、品名。
 */
export function validateForCarrier(
  req: CreateShipmentRequest,
  adapter: CarrierAdapter,
): { errors: Record<string, string>; normalized: NormalizedShipment } {
  const errors: Record<string, string> = {};
  const caps = adapter.capabilities;
  const limits = adapter.limits;
  const recipient = { ...req.recipient };

  const phone = normalizePhone(recipient.phone);
  if (!phone) errors['recipient.phone'] = '電話格式錯誤（手機 09 開頭 10 碼，或市話含區碼）';
  else recipient.phone = phone;

  if (req.service_type === 'HOME_DELIVERY') {
    if (!caps.homeDelivery) errors.service_type = `${adapter.code} 不支援宅配`;
    if (!recipient.address) errors['recipient.address'] = '宅配必須提供地址';
    else {
      const { zip, rest } = extractZip(recipient.address);
      if (zip && !recipient.zip) recipient.zip = zip;
      recipient.address = rest;
      if (!hasCity(rest)) errors['recipient.address'] = '地址必須包含縣市';
    }
    if (req.cvs_store) errors.cvs_store = '宅配不可指定門市';
  } else {
    if (!caps.cvsPickup) errors.service_type = `${adapter.code} 不支援超商取貨`;
    if (!req.cvs_store) errors.cvs_store = '超商取貨必須指定門市（先走電子地圖選店）';
    else {
      if (req.cvs_store.carrier_code && req.cvs_store.carrier_code !== adapter.code)
        errors['cvs_store.carrier_code'] = `門市屬於 ${req.cvs_store.carrier_code}，與物流商 ${adapter.code} 不一致`;
      if (limits.cvsSubTypes && !limits.cvsSubTypes.includes(req.cvs_store.sub_type))
        errors['cvs_store.sub_type'] = `${adapter.code} 不支援 ${req.cvs_store.sub_type}`;
    }
  }

  if (!caps.temperatures.includes(req.temperature)) errors.temperature = `${adapter.code} 不支援溫層 ${req.temperature}`;
  if (req.cod_amount) {
    if (!caps.cod) errors.cod_amount = `${adapter.code} 不支援貨到付款`;
    else if (limits.codMaxAmount && req.cod_amount > limits.codMaxAmount)
      errors.cod_amount = `代收金額上限 ${limits.codMaxAmount}`;
  }
  if (req.declared_value && limits.declaredValueMax && req.declared_value > limits.declaredValueMax)
    errors.declared_value = `申報價值上限 ${limits.declaredValueMax}`;
  if (limits.recipientNameMaxLength && [...recipient.name].length > limits.recipientNameMaxLength)
    errors['recipient.name'] = `收件人姓名上限 ${limits.recipientNameMaxLength} 字`;

  const items = sanitizeItems(req.items_summary || '商品', limits.itemsSummaryMaxLength) || '商品';

  return { errors, normalized: { ...req, recipient, items_summary: items } };
}

/** adapter 特定檢查用的輸入（建單前 dry-run，不含 callbackUrl） */
export function toCarrierInput(
  shipmentId: string,
  n: NormalizedShipment,
  sender: CreateShipmentInput['sender'],
  callbackUrl: string,
): CreateShipmentInput {
  return {
    shipmentId,
    serviceType: n.service_type,
    recipient: n.recipient,
    cvsStore: n.cvs_store ?? null,
    sender,
    temperature: n.temperature,
    codAmount: n.cod_amount ?? null,
    declaredValue: n.declared_value ?? null,
    itemsSummary: n.items_summary,
    package: n.package ?? null,
    preferredTimeSlot: n.preferred_time_slot ?? null,
    scheduledPickupAt: n.scheduled_pickup_at ? new Date(n.scheduled_pickup_at) : null,
    callbackUrl,
  };
}
