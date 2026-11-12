export type ShipmentStatus =
  | 'CREATED'
  | 'LABEL_PENDING'
  | 'READY_TO_SHIP'
  | 'PICKED_UP'
  | 'IN_TRANSIT'
  | 'OUT_FOR_DELIVERY'
  | 'ARRIVED_AT_STORE'
  | 'DELIVERED'
  | 'EXCEPTION'
  | 'RETURNING'
  | 'RETURNED'
  | 'CANCELLED'
  | 'FAILED';

export const STATUS_LABEL: Record<ShipmentStatus, string> = {
  CREATED: '已建立',
  LABEL_PENDING: '等待取號',
  READY_TO_SHIP: '待交寄',
  PICKED_UP: '已取件',
  IN_TRANSIT: '運送中',
  OUT_FOR_DELIVERY: '配送中',
  ARRIVED_AT_STORE: '已到店',
  DELIVERED: '已送達',
  EXCEPTION: '異常',
  RETURNING: '退回中',
  RETURNED: '已退回',
  CANCELLED: '已取消',
  FAILED: '建單失敗',
};

export const STATUSES = Object.keys(STATUS_LABEL) as ShipmentStatus[];

export interface Shipment {
  id: string;
  external_ref: string;
  status: ShipmentStatus;
  carrier_code: string;
  carrier_account_id: string;
  service_type: 'HOME_DELIVERY' | 'CVS_PICKUP';
  tracking_number: string | null;
  carrier_shipment_id: string | null;
  temperature: string;
  recipient: { name: string; phone: string; zip?: string; address?: string; email?: string };
  cvs_store: { sub_type: string; store_id: string; store_name?: string; store_address?: string } | null;
  cod_amount: number | null;
  declared_value: number | null;
  items_summary: string | null;
  preferred_time_slot: string | null;
  label_available: boolean;
  label_content_type: string | null;
  metadata: Record<string, unknown>;
  last_error: string | null;
  attempt_count: number;
  delivered_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Me {
  sub: string;
  email: string | null;
  name: string | null;
  roles: string[];
  protocol: 'oidc' | 'oauth2' | null;
  csrf_token: string;
  dev_bypass: boolean;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

let csrf = '';
export const setCsrf = (t: string) => (csrf = t);
export const getCsrf = () => csrf;

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  if (init.method && init.method !== 'GET') headers.set('x-csrf-token', csrf);
  const res = await fetch(path, { ...init, headers, body, credentials: 'same-origin' });
  if (res.status === 401 && !path.startsWith('/auth/')) {
    window.location.href = `/login?return_to=${encodeURIComponent(location.pathname + location.search)}`;
    throw new ApiError(401, 'unauthenticated', '請重新登入');
  }
  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = (data as { error?: { code: string; message: string; details?: unknown } })?.error;
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? `HTTP ${res.status}`, err?.details);
  }
  return data as T;
}

export const qs = (params: Record<string, string | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.details && typeof err.details === 'object' && !Array.isArray(err.details)) {
      const lines = Object.entries(err.details as Record<string, unknown>)
        .filter(([, v]) => typeof v === 'string')
        .map(([k, v]) => `${k}：${v}`);
      if (lines.length) return `${err.message}\n${lines.join('\n')}`;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
