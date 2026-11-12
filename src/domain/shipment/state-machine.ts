import type { ServiceType, ShipmentStatus } from './types.js';

export const TERMINAL_STATUSES: readonly ShipmentStatus[] = ['DELIVERED', 'RETURNED', 'CANCELLED', 'FAILED'];

export const isTerminal = (s: ShipmentStatus) => TERMINAL_STATUSES.includes(s);

/** 已交給物流商、實際在路上的狀態（規格：「任何運送中狀態皆可進入」例外分支） */
export const IN_FLIGHT: readonly ShipmentStatus[] = [
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'ARRIVED_AT_STORE',
];

/**
 * 合法轉換表（規格第 4 節）。
 * - 物流商可能漏報中間狀態，所以允許「往前跳」（例如 READY_TO_SHIP 直接 DELIVERED）。
 * - 不允許往回走：回調亂序時舊狀態會被忽略，但軌跡仍會保留。
 * - EXCEPTION 排除後可回到運送中狀態或直接送達／退回。
 * - FAILED → CREATED 不在表內，只能透過 retry 操作（resetForRetry）。
 */
const TRANSITIONS: Record<ShipmentStatus, readonly ShipmentStatus[]> = {
  CREATED: ['LABEL_PENDING', 'READY_TO_SHIP', 'CANCELLED', 'FAILED'],
  LABEL_PENDING: ['READY_TO_SHIP', 'FAILED', 'CANCELLED', 'PICKED_UP', 'IN_TRANSIT'],
  READY_TO_SHIP: [
    'PICKED_UP',
    'IN_TRANSIT',
    'OUT_FOR_DELIVERY',
    'ARRIVED_AT_STORE',
    'DELIVERED',
    'CANCELLED',
    'EXCEPTION',
  ],
  PICKED_UP: ['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'ARRIVED_AT_STORE', 'DELIVERED', 'EXCEPTION', 'RETURNING'],
  IN_TRANSIT: ['OUT_FOR_DELIVERY', 'ARRIVED_AT_STORE', 'DELIVERED', 'EXCEPTION', 'RETURNING'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'EXCEPTION', 'RETURNING'],
  ARRIVED_AT_STORE: ['DELIVERED', 'EXCEPTION', 'RETURNING'],
  EXCEPTION: ['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'ARRIVED_AT_STORE', 'DELIVERED', 'RETURNING', 'RETURNED'],
  RETURNING: ['RETURNED', 'EXCEPTION'],
  DELIVERED: [],
  RETURNED: [],
  CANCELLED: [],
  FAILED: [],
};

/** 只屬於某種服務類型的狀態 */
const SERVICE_ONLY: Partial<Record<ShipmentStatus, ServiceType>> = {
  OUT_FOR_DELIVERY: 'HOME_DELIVERY',
  ARRIVED_AT_STORE: 'CVS_PICKUP',
};

export type TransitionCheck =
  | { ok: true }
  | { ok: false; reason: 'same_status' | 'terminal' | 'not_allowed' | 'wrong_service_type' };

export function checkTransition(
  from: ShipmentStatus,
  to: ShipmentStatus,
  serviceType?: ServiceType,
): TransitionCheck {
  if (from === to) return { ok: false, reason: 'same_status' };
  if (isTerminal(from)) return { ok: false, reason: 'terminal' };
  const only = SERVICE_ONLY[to];
  if (serviceType && only && only !== serviceType) return { ok: false, reason: 'wrong_service_type' };
  return TRANSITIONS[from].includes(to) ? { ok: true } : { ok: false, reason: 'not_allowed' };
}

export const canTransition = (from: ShipmentStatus, to: ShipmentStatus, serviceType?: ServiceType) =>
  checkTransition(from, to, serviceType).ok;

export const allowedNext = (from: ShipmentStatus): readonly ShipmentStatus[] => TRANSITIONS[from];

/** 取消只能在交寄前 */
export const CANCELLABLE: readonly ShipmentStatus[] = ['CREATED', 'LABEL_PENDING', 'READY_TO_SHIP'];

/** 可以 retry（重新送物流商）的狀態 */
export const RETRYABLE: readonly ShipmentStatus[] = ['FAILED'];
