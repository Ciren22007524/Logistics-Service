export const SHIPMENT_STATUSES = [
  'CREATED',
  'LABEL_PENDING',
  'READY_TO_SHIP',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'ARRIVED_AT_STORE',
  'DELIVERED',
  'EXCEPTION',
  'RETURNING',
  'RETURNED',
  'CANCELLED',
  'FAILED',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const SERVICE_TYPES = ['HOME_DELIVERY', 'CVS_PICKUP'] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const TEMPERATURES = ['NORMAL', 'CHILLED', 'FROZEN'] as const;
export type Temperature = (typeof TEMPERATURES)[number];

export type TrackingSource = 'CALLBACK' | 'POLLING' | 'MANUAL';

export interface Recipient {
  name: string;
  phone: string;
  email?: string;
  zip?: string;
  address?: string;
}

export interface CvsStore {
  /** 物流商子類型，例如 ECPay 的 UNIMARTC2C、FAMI */
  sub_type: string;
  store_id: string;
  store_name?: string;
  store_address?: string;
  carrier_code?: string;
}

export interface PackageInfo {
  weight_g?: number | null;
  length_cm?: number | null;
  width_cm?: number | null;
  height_cm?: number | null;
  size_code?: string | null;
}

export interface SenderInfo {
  name: string;
  phone: string;
  zip?: string;
  address?: string;
  email?: string;
}

/** DB 列（snake_case 與資料表一致） */
export interface ShipmentRow {
  id: string;
  tenant_id: string;
  carrier_account_id: string;
  carrier_code: string;
  service_type: ServiceType;
  external_ref: string;
  idempotency_key: string;
  request_hash: string | null;
  status: ShipmentStatus;
  tracking_number: string | null;
  carrier_shipment_id: string | null;
  recipient: Recipient;
  cvs_store: CvsStore | null;
  temperature: Temperature;
  cod_amount: number | null;
  declared_value: number | null;
  items_summary: string | null;
  scheduled_pickup_at: Date | null;
  preferred_time_slot: string | null;
  label_url: string | null;
  label_content_type: string | null;
  carrier_payload: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  last_error: string | null;
  attempt_count: number;
  last_tracking_at: Date | null;
  delivered_at: Date | null;
  cancelled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface TrackingEventRow {
  id: string;
  shipment_id: string;
  status: ShipmentStatus;
  raw_status: string;
  description: string | null;
  location: string | null;
  occurred_at: Date;
  received_at: Date;
  source: TrackingSource;
  applied: boolean;
  raw_payload: unknown;
}
