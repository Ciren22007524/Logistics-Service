-- 物流管理平台初始結構（規格第 5 節）。
-- 與規格的差異（皆為新增，不改原欄位語意）：
--   tenants.store_map_return_origins  超商選店後允許導回的來源（防 open redirect）
--   shipments.request_hash            同一 Idempotency-Key 但內容不同時回 409
--   shipments.label_content_type      ECPay 標籤為 HTML，非 PDF
--   shipments.last_tracking_at        poll-tracking 判斷「N 小時沒更新」
--   carrier_callbacks.kind / carrier_account_id / shipment_id  方便後台追查
--   outbox_events.sent_at

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenants (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     TEXT NOT NULL,
  webhook_url              TEXT,
  webhook_secret           TEXT NOT NULL,
  store_map_return_origins TEXT[] NOT NULL DEFAULT '{}',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  key_hash    TEXT NOT NULL UNIQUE,
  key_prefix  TEXT NOT NULL,
  label       TEXT,
  revoked_at  TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE carrier_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  carrier_code    TEXT NOT NULL,
  name            TEXT NOT NULL,
  credentials_enc BYTEA NOT NULL,
  is_sandbox      BOOLEAN NOT NULL DEFAULT true,
  is_default      BOOLEAN NOT NULL DEFAULT false,
  sender_info     JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 每個租戶、每家物流商最多一個預設帳號
CREATE UNIQUE INDEX carrier_accounts_default_uq
  ON carrier_accounts (tenant_id, carrier_code) WHERE is_default;

CREATE TABLE shipments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  carrier_account_id  UUID NOT NULL REFERENCES carrier_accounts(id),
  carrier_code        TEXT NOT NULL,
  service_type        TEXT NOT NULL CHECK (service_type IN ('HOME_DELIVERY','CVS_PICKUP')),
  external_ref        TEXT NOT NULL,
  idempotency_key     TEXT NOT NULL,
  request_hash        TEXT,

  status              TEXT NOT NULL DEFAULT 'CREATED',
  tracking_number     TEXT,
  carrier_shipment_id TEXT,

  recipient           JSONB NOT NULL,
  cvs_store           JSONB,
  temperature         TEXT NOT NULL DEFAULT 'NORMAL' CHECK (temperature IN ('NORMAL','CHILLED','FROZEN')),
  cod_amount          INTEGER CHECK (cod_amount IS NULL OR cod_amount > 0),
  declared_value      INTEGER,
  items_summary       TEXT,
  scheduled_pickup_at TIMESTAMPTZ,
  preferred_time_slot TEXT,

  label_url           TEXT,
  label_content_type  TEXT,
  carrier_payload     JSONB,
  metadata            JSONB NOT NULL DEFAULT '{}',

  last_error          TEXT,
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  last_tracking_at    TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX shipments_tenant_ref_idx ON shipments (tenant_id, external_ref);
CREATE INDEX shipments_tracking_idx ON shipments (carrier_code, tracking_number);
CREATE INDEX shipments_carrier_sid_idx ON shipments (carrier_code, carrier_shipment_id);
CREATE INDEX shipments_active_status_idx ON shipments (status)
  WHERE status NOT IN ('DELIVERED','RETURNED','CANCELLED','FAILED');
CREATE INDEX shipments_tenant_created_idx ON shipments (tenant_id, created_at DESC, id DESC);

CREATE TABLE packages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id  UUID NOT NULL REFERENCES shipments(id),
  weight_g     INTEGER,
  length_cm    INTEGER,
  width_cm     INTEGER,
  height_cm    INTEGER,
  size_code    TEXT
);
CREATE INDEX packages_shipment_idx ON packages (shipment_id);

CREATE TABLE tracking_events (
  id            BIGSERIAL PRIMARY KEY,
  shipment_id   UUID NOT NULL REFERENCES shipments(id),
  status        TEXT NOT NULL,
  raw_status    TEXT NOT NULL,
  description   TEXT,
  location      TEXT,
  occurred_at   TIMESTAMPTZ NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  source        TEXT NOT NULL CHECK (source IN ('CALLBACK','POLLING','MANUAL')),
  applied       BOOLEAN NOT NULL DEFAULT false,
  raw_payload   JSONB,
  UNIQUE (shipment_id, raw_status, occurred_at)
);
CREATE INDEX tracking_events_shipment_idx ON tracking_events (shipment_id, occurred_at);

CREATE TABLE carrier_callbacks (
  id                 BIGSERIAL PRIMARY KEY,
  carrier_code       TEXT NOT NULL,
  kind               TEXT NOT NULL DEFAULT 'TRACKING',   -- TRACKING | STORE_SELECTION
  carrier_account_id UUID,
  shipment_id        UUID,
  headers            JSONB,
  body               TEXT NOT NULL,
  verified           BOOLEAN,
  processed_at       TIMESTAMPTZ,
  error              TEXT,
  received_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX carrier_callbacks_unprocessed_idx ON carrier_callbacks (received_at) WHERE processed_at IS NULL;

CREATE TABLE outbox_events (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      UUID NOT NULL,
  event_type     TEXT NOT NULL,
  payload        JSONB NOT NULL,
  status         TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','DEAD')),
  attempt_count  INTEGER NOT NULL DEFAULT 0,
  next_retry_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error     TEXT,
  sent_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX outbox_events_dispatch_idx ON outbox_events (status, next_retry_at);
CREATE INDEX outbox_events_shipment_idx ON outbox_events ((payload->'data'->>'shipment_id'));

CREATE TABLE audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_id   UUID,
  detail      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_target_idx ON audit_logs (target_id, created_at);
