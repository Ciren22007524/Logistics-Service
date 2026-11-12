import type {
  CvsStore,
  PackageInfo,
  Recipient,
  SenderInfo,
  ServiceType,
  ShipmentRow,
  ShipmentStatus,
  Temperature,
} from '../domain/shipment/types.js';

export type CarrierCode = 'MOCK' | 'ECPAY_CVS' | 'BLACKCAT' | 'HCT';

export interface CarrierCapabilities {
  homeDelivery: boolean;
  cvsPickup: boolean;
  cod: boolean;
  temperatures: Temperature[];
  cancel: boolean;
  /** 是否支援主動回調 */
  trackingCallback: boolean;
  trackingPolling: boolean;
  storeMap: boolean;
}

export interface CarrierLimits {
  itemsSummaryMaxLength: number;
  codMaxAmount?: number;
  declaredValueMax?: number;
  recipientNameMaxLength?: number;
  /** 超商可用的子類型（例如 ECPay：UNIMARTC2C、FAMIC2C…） */
  cvsSubTypes?: string[];
}

/** 解密後的帳號（credentials 只存在記憶體） */
export interface CarrierAccount {
  id: string;
  tenant_id: string;
  carrier_code: string;
  name: string;
  credentials: Record<string, string>;
  is_sandbox: boolean;
  is_default: boolean;
  sender_info: SenderInfo;
}

export interface CreateShipmentInput {
  shipmentId: string;
  serviceType: ServiceType;
  recipient: Recipient;
  cvsStore: CvsStore | null;
  sender: SenderInfo;
  temperature: Temperature;
  codAmount: number | null;
  declaredValue: number | null;
  itemsSummary: string;
  package: PackageInfo | null;
  preferredTimeSlot: string | null;
  scheduledPickupAt: Date | null;
  /** 物流商回調網址（已含 account id） */
  callbackUrl: string;
}

export interface CreateShipmentResult {
  trackingNumber: string | null;
  carrierShipmentId: string | null;
  /** 有託運單號且可以取標籤 → READY_TO_SHIP；否則 LABEL_PENDING 等回調或下一輪查詢 */
  labelAvailable: boolean;
  /** 存進 shipments.carrier_payload（除錯用，不要放金鑰） */
  raw: Record<string, unknown>;
}

export interface LabelFile {
  content: Uint8Array;
  contentType: string;
  extension: string;
}

export interface CarrierTrackingEvent {
  rawStatus: string;
  /** null = 不推進平台狀態，只保留軌跡 */
  status: ShipmentStatus | null;
  description?: string;
  location?: string;
  occurredAt: Date;
  raw?: unknown;
}

export interface RawCallback {
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string>;
  contentType: string;
  body: string;
}

export interface ParsedCallback {
  trackingNumber?: string;
  carrierShipmentId?: string;
  /** 若物流商會回傳我們送過去的自訂編號，直接對回 shipment */
  shipmentRef?: string;
  events: CarrierTrackingEvent[];
}

export interface StoreMapParams {
  subType: string;
  /** 物流商選完門市 POST 回來的網址（平台內部），由平台產生 */
  replyUrl: string;
  /** 平台的選店 token，原樣帶回 */
  state: string;
  isCollection: boolean;
  device: 'PC' | 'MOBILE';
}

/** 取得門市地圖的方式：直接 GET 或需要瀏覽器自動送出表單 */
export type StoreMapRequest =
  | { method: 'GET'; url: string }
  | { method: 'POST'; url: string; fields: Record<string, string> };

export interface CarrierAdapter {
  readonly code: CarrierCode;
  readonly displayName: string;
  readonly capabilities: CarrierCapabilities;
  readonly limits: CarrierLimits;

  createShipment(input: CreateShipmentInput, account: CarrierAccount): Promise<CreateShipmentResult>;
  getLabel(shipment: ShipmentRow, account: CarrierAccount): Promise<LabelFile>;
  cancelShipment(shipment: ShipmentRow, account: CarrierAccount): Promise<void>;
  queryTracking(shipment: ShipmentRow, account: CarrierAccount): Promise<CarrierTrackingEvent[]>;

  /** 只解析識別資訊與事件，不做驗簽 */
  parseCallback(req: RawCallback): ParsedCallback;
  verifyCallback(req: RawCallback, account: CarrierAccount): boolean;
  callbackAck(result: 'OK' | 'ERROR'): { status: number; body: string; contentType?: string };

  mapStatus(rawStatus: string): ShipmentStatus | null;

  /** 建單前的物流商特定檢查，回傳 field → message */
  validate?(input: CreateShipmentInput): Record<string, string>;

  // 超商專用（選擇性實作）
  getStoreMapRequest?(params: StoreMapParams, account: CarrierAccount): Promise<StoreMapRequest>;
  parseStoreSelection?(req: RawCallback): { state: string; store: CvsStore };
}
