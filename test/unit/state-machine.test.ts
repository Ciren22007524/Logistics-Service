import { describe, expect, it } from 'vitest';
import { CANCELLABLE, checkTransition, isTerminal, TERMINAL_STATUSES } from '../../src/domain/shipment/state-machine.js';
import { SHIPMENT_STATUSES, type ShipmentStatus } from '../../src/domain/shipment/types.js';

const legal: [ShipmentStatus, ShipmentStatus][] = [
  ['CREATED', 'LABEL_PENDING'],
  ['CREATED', 'CANCELLED'],
  ['CREATED', 'FAILED'],
  ['LABEL_PENDING', 'READY_TO_SHIP'],
  ['LABEL_PENDING', 'FAILED'],
  ['READY_TO_SHIP', 'PICKED_UP'],
  ['READY_TO_SHIP', 'CANCELLED'],
  ['PICKED_UP', 'IN_TRANSIT'],
  ['IN_TRANSIT', 'OUT_FOR_DELIVERY'],
  ['IN_TRANSIT', 'ARRIVED_AT_STORE'],
  ['OUT_FOR_DELIVERY', 'DELIVERED'],
  ['ARRIVED_AT_STORE', 'DELIVERED'],
  ['IN_TRANSIT', 'EXCEPTION'],
  ['EXCEPTION', 'IN_TRANSIT'],
  ['ARRIVED_AT_STORE', 'RETURNING'],
  ['RETURNING', 'RETURNED'],
  // 物流商漏報中間狀態時允許往前跳
  ['READY_TO_SHIP', 'DELIVERED'],
];

const illegal: [ShipmentStatus, ShipmentStatus][] = [
  ['IN_TRANSIT', 'PICKED_UP'],
  ['DELIVERED', 'IN_TRANSIT'],
  ['PICKED_UP', 'CANCELLED'],
  ['CREATED', 'DELIVERED'],
  ['CANCELLED', 'CREATED'],
  ['FAILED', 'CREATED'],
  ['RETURNED', 'RETURNING'],
  ['READY_TO_SHIP', 'RETURNING'],
];

describe('shipment state machine', () => {
  it.each(legal)('%s → %s is allowed', (from, to) => {
    expect(checkTransition(from, to).ok).toBe(true);
  });

  it.each(illegal)('%s → %s is rejected', (from, to) => {
    expect(checkTransition(from, to).ok).toBe(false);
  });

  it('terminal states never move', () => {
    for (const from of TERMINAL_STATUSES)
      for (const to of SHIPMENT_STATUSES) expect(checkTransition(from, to).ok, `${from}->${to}`).toBe(false);
  });

  it('same status is a no-op, not an error', () => {
    expect(checkTransition('IN_TRANSIT', 'IN_TRANSIT')).toEqual({ ok: false, reason: 'same_status' });
  });

  it('service-type specific states', () => {
    expect(checkTransition('IN_TRANSIT', 'ARRIVED_AT_STORE', 'HOME_DELIVERY')).toEqual({ ok: false, reason: 'wrong_service_type' });
    expect(checkTransition('IN_TRANSIT', 'OUT_FOR_DELIVERY', 'CVS_PICKUP')).toEqual({ ok: false, reason: 'wrong_service_type' });
    expect(checkTransition('IN_TRANSIT', 'ARRIVED_AT_STORE', 'CVS_PICKUP').ok).toBe(true);
  });

  it('exhaustive: every pair has a defined answer and terminals match spec', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(['CANCELLED', 'DELIVERED', 'FAILED', 'RETURNED']);
    for (const s of SHIPMENT_STATUSES) expect(typeof isTerminal(s)).toBe('boolean');
    expect(CANCELLABLE).not.toContain('PICKED_UP');
  });
});
