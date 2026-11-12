import { toTaipeiIso } from '../../lib/time.js';
import type { ShipmentRow, TrackingEventRow } from './types.js';

/** 對上游的 Shipment JSON（時間一律 +08:00；不輸出內部欄位如 label_url、carrier_payload） */
export function serializeShipment(s: ShipmentRow) {
  return {
    id: s.id,
    external_ref: s.external_ref,
    status: s.status,
    carrier_code: s.carrier_code,
    carrier_account_id: s.carrier_account_id,
    service_type: s.service_type,
    tracking_number: s.tracking_number,
    carrier_shipment_id: s.carrier_shipment_id,
    temperature: s.temperature,
    recipient: s.recipient,
    cvs_store: s.cvs_store,
    cod_amount: s.cod_amount,
    declared_value: s.declared_value,
    items_summary: s.items_summary,
    preferred_time_slot: s.preferred_time_slot,
    scheduled_pickup_at: toTaipeiIso(s.scheduled_pickup_at),
    label_available: Boolean(s.label_url),
    label_content_type: s.label_content_type,
    metadata: s.metadata,
    last_error: s.last_error,
    attempt_count: s.attempt_count,
    delivered_at: toTaipeiIso(s.delivered_at),
    cancelled_at: toTaipeiIso(s.cancelled_at),
    created_at: toTaipeiIso(s.created_at),
    updated_at: toTaipeiIso(s.updated_at),
  };
}

export function serializeTrackingEvent(e: TrackingEventRow) {
  return {
    status: e.status,
    raw_status: e.raw_status,
    description: e.description,
    location: e.location,
    occurred_at: toTaipeiIso(e.occurred_at),
    received_at: toTaipeiIso(e.received_at),
    source: e.source,
    applied: e.applied,
  };
}
