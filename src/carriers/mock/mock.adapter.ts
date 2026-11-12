import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { CvsStore, ShipmentRow, ShipmentStatus } from '../../domain/shipment/types.js';
import { hmacSha256, safeEqual } from '../../infra/crypto/secrets.js';
import type {
  CarrierAccount,
  CarrierAdapter,
  CarrierTrackingEvent,
  CreateShipmentInput,
  CreateShipmentResult,
  LabelFile,
  ParsedCallback,
  RawCallback,
  StoreMapParams,
  StoreMapRequest,
} from '../carrier.interface.js';
import { AuthError, RetryableError, ValidationError } from '../errors.js';

/**
 * 本機模擬物流商：不連外，讓「建單 → 取標籤 → 回調 → webhook」在開發環境完整跑通。
 * - 收件人姓名含「驗證失敗」→ ValidationError；地址含「#retry」→ 第一次 RetryableError
 * - 回調格式：JSON，header `x-mock-signature: HMAC-SHA256(body, credentials.callbackSecret)`
 * - 後台「模擬狀態」會以同樣格式打 /callbacks/MOCK/{account_id}，走完整回調流程
 */
export const MOCK_STATUS_CODES: Record<string, { status: ShipmentStatus; label: string }> = {
  M00: { status: 'READY_TO_SHIP', label: '已建立託運單' },
  M10: { status: 'PICKED_UP', label: '已取件' },
  M20: { status: 'IN_TRANSIT', label: '轉運中' },
  M30: { status: 'OUT_FOR_DELIVERY', label: '配送中' },
  M31: { status: 'ARRIVED_AT_STORE', label: '已到店' },
  M40: { status: 'DELIVERED', label: '已簽收／已取貨' },
  M50: { status: 'EXCEPTION', label: '異常（地址錯誤／拒收）' },
  M60: { status: 'RETURNING', label: '退回中' },
  M70: { status: 'RETURNED', label: '已退回' },
};

export const MOCK_STORES: CvsStore[] = [
  { sub_type: 'MOCK711', store_id: '991182', store_name: '模擬 7-11 桃園門市', store_address: '桃園市桃園區中正路1號' },
  { sub_type: 'MOCK711', store_id: '991183', store_name: '模擬 7-11 台北門市', store_address: '台北市中正區重慶南路1段1號' },
  { sub_type: 'MOCKFAMI', store_id: '017261', store_name: '模擬全家 新竹門市', store_address: '新竹市東區光復路2段1號' },
];

const retriedOnce = new Set<string>();

const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, '*');

export class MockAdapter implements CarrierAdapter {
  readonly code = 'MOCK' as const;
  readonly displayName = '模擬物流（開發用）';
  readonly capabilities = {
    homeDelivery: true,
    cvsPickup: true,
    cod: true,
    temperatures: ['NORMAL' as const, 'CHILLED' as const, 'FROZEN' as const],
    cancel: true,
    trackingCallback: true,
    trackingPolling: false,
    storeMap: true,
  };
  readonly limits = {
    itemsSummaryMaxLength: 30,
    codMaxAmount: 20000,
    cvsSubTypes: ['MOCK711', 'MOCKFAMI'],
  };

  constructor(private readonly publicBaseUrl: string) {}

  validate(input: CreateShipmentInput): Record<string, string> {
    const errors: Record<string, string> = {};
    if (input.serviceType === 'CVS_PICKUP') {
      const store = input.cvsStore;
      if (!store) errors.cvs_store = '必須指定門市';
      else if (!MOCK_STORES.some((s) => s.store_id === store.store_id && s.sub_type === store.sub_type))
        errors['cvs_store.store_id'] = '門市不存在或與超商類型不符';
    }
    return errors;
  }

  async createShipment(input: CreateShipmentInput, _account: CarrierAccount): Promise<CreateShipmentResult> {
    if (input.recipient.name.includes('驗證失敗'))
      throw new ValidationError('模擬：收件人資料不正確', { 'recipient.name': 'rejected by carrier' });
    if (input.recipient.address?.includes('#retry') && !retriedOnce.has(input.shipmentId)) {
      retriedOnce.add(input.shipmentId);
      throw new RetryableError('模擬：物流商逾時');
    }
    // 同一 shipment 永遠拿到同一個號碼 → 重送不會重複建單
    const digits = BigInt(`0x${createHash('sha256').update(input.shipmentId).digest('hex').slice(0, 12)}`)
      .toString()
      .padStart(12, '0')
      .slice(0, 12);
    return {
      trackingNumber: digits,
      carrierShipmentId: `MOCK-${input.shipmentId.slice(0, 8)}`,
      labelAvailable: true,
      raw: { mock: true, tracking_number: digits },
    };
  }

  async getLabel(shipment: ShipmentRow, _account: CarrierAccount): Promise<LabelFile> {
    if (!shipment.tracking_number) throw new ValidationError('尚未取號');
    const pdf = await PDFDocument.create();
    // 100mm x 150mm 熱感標籤尺寸
    const page = pdf.addPage([283, 425]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    page.drawText('MOCK CARRIER', { x: 20, y: 390, size: 16, font: bold });
    const service = shipment.service_type === 'CVS_PICKUP' ? 'CVS PICKUP' : 'HOME DELIVERY';
    page.drawText(service, { x: 20, y: 370, size: 10, font });
    // 假條碼：依號碼每位數字畫寬窄條
    let x = 20;
    for (const ch of shipment.tracking_number) {
      const n = Number(ch);
      for (let i = 0; i < 4; i++) {
        const w = ((n >> i) & 1) + 1;
        page.drawRectangle({ x, y: 290, width: w, height: 60, color: rgb(0, 0, 0) });
        x += w + 1.5;
      }
      x += 2;
    }
    page.drawText(shipment.tracking_number, { x: 20, y: 272, size: 14, font: bold });
    const phone = shipment.recipient.phone;
    const lines = [
      `Ref: ${ascii(shipment.external_ref)}`,
      `Shipment: ${shipment.id}`,
      `Temp: ${shipment.temperature}`,
      shipment.cod_amount ? `COD: NT$${shipment.cod_amount}` : 'COD: -',
      shipment.cvs_store ? `Store: ${shipment.cvs_store.sub_type} ${shipment.cvs_store.store_id}` : '',
      `Phone: ${ascii(phone.slice(0, 4))}***${ascii(phone.slice(-3))}`,
    ].filter(Boolean);
    lines.forEach((line, i) => page.drawText(line, { x: 20, y: 240 - i * 16, size: 9, font }));
    page.drawText('SANDBOX - NOT FOR REAL SHIPPING', { x: 20, y: 20, size: 8, font, color: rgb(0.6, 0, 0) });
    return { content: await pdf.save(), contentType: 'application/pdf', extension: 'pdf' };
  }

  async cancelShipment(shipment: ShipmentRow, _account: CarrierAccount): Promise<void> {
    if (shipment.recipient.name.includes('不可取消')) throw new ValidationError('模擬：物流商拒絕取消');
  }

  async queryTracking(_shipment: ShipmentRow, _account: CarrierAccount): Promise<CarrierTrackingEvent[]> {
    return [];
  }

  parseCallback(req: RawCallback): ParsedCallback {
    let body: {
      tracking_number?: string;
      status_code?: string;
      description?: string;
      location?: string;
      occurred_at?: string;
    };
    try {
      body = JSON.parse(req.body);
    } catch {
      throw new ValidationError('模擬回調不是 JSON');
    }
    if (!body.tracking_number || !body.status_code) throw new ValidationError('模擬回調缺少欄位');
    return {
      trackingNumber: body.tracking_number,
      events: [
        {
          rawStatus: body.status_code,
          status: this.mapStatus(body.status_code),
          description: body.description ?? MOCK_STATUS_CODES[body.status_code]?.label,
          location: body.location,
          occurredAt: body.occurred_at ? new Date(body.occurred_at) : new Date(),
          raw: body,
        },
      ],
    };
  }

  verifyCallback(req: RawCallback, account: CarrierAccount): boolean {
    const secret = account.credentials.callbackSecret;
    if (!secret) throw new AuthError('MOCK 帳號缺少 callbackSecret');
    const sig = req.headers['x-mock-signature'];
    return typeof sig === 'string' && safeEqual(sig, hmacSha256(secret, req.body));
  }

  callbackAck(result: 'OK' | 'ERROR') {
    return result === 'OK'
      ? { status: 200, body: '{"ok":true}', contentType: 'application/json' }
      : { status: 400, body: '{"ok":false}', contentType: 'application/json' };
  }

  mapStatus(rawStatus: string): ShipmentStatus | null {
    return MOCK_STATUS_CODES[rawStatus]?.status ?? null;
  }

  async getStoreMapRequest(params: StoreMapParams, _account: CarrierAccount): Promise<StoreMapRequest> {
    const url = new URL('/mock-carrier/store-map', this.publicBaseUrl);
    url.searchParams.set('reply', params.replyUrl);
    url.searchParams.set('state', params.state);
    url.searchParams.set('sub_type', params.subType);
    return { method: 'GET', url: url.toString() };
  }

  parseStoreSelection(req: RawCallback): { state: string; store: CvsStore } {
    const data = Object.fromEntries(new URLSearchParams(req.body));
    const store = MOCK_STORES.find((s) => s.store_id === data.store_id);
    if (!store) throw new ValidationError('模擬門市不存在');
    return { state: data.state ?? '', store: { ...store, carrier_code: this.code } };
  }
}

/** 產生模擬回調（後台模擬按鈕與測試共用） */
export function buildMockCallback(secret: string, payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  return { body, signature: hmacSha256(secret, body) };
}
