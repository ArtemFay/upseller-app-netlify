CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS wms;

SET search_path TO wms, public;

CREATE TABLE IF NOT EXISTS clients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS employees (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    role_name TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE,
    zone_name TEXT,
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS supplies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_ref TEXT NOT NULL UNIQUE,
    client_id UUID NOT NULL REFERENCES clients(id),
    status_name TEXT NOT NULL DEFAULT 'draft',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cargo_places (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_ref TEXT NOT NULL UNIQUE,
    supply_id UUID REFERENCES supplies(id),
    client_id UUID NOT NULL REFERENCES clients(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id),
    client_sku TEXT NOT NULL,
    product_name TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_id, client_sku)
);

CREATE TABLE IF NOT EXISTS barcodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id),
    barcode TEXT NOT NULL UNIQUE,
    barcode_kind TEXT NOT NULL DEFAULT 'client',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS box_types (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS item_statuses (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS box_statuses (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS object_types (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS effect_types (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS correction_reasons (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_types (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    object_type_code TEXT NOT NULL REFERENCES object_types(code),
    affects_inventory BOOLEAN NOT NULL DEFAULT FALSE,
    affects_box_state BOOLEAN NOT NULL DEFAULT FALSE,
    affects_box_content BOOLEAN NOT NULL DEFAULT FALSE,
    affects_item_status BOOLEAN NOT NULL DEFAULT FALSE,
    affects_box_status BOOLEAN NOT NULL DEFAULT FALSE,
    default_effect_type_code TEXT REFERENCES effect_types(code),
    is_report_level BOOLEAN NOT NULL DEFAULT FALSE,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS boxes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    box_code TEXT NOT NULL UNIQUE,
    client_id UUID NOT NULL REFERENCES clients(id),
    box_type_code TEXT REFERENCES box_types(code),
    current_status_code TEXT REFERENCES box_statuses(code),
    current_location_id UUID REFERENCES locations(id),
    archived_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_ref TEXT NOT NULL UNIQUE,
    document_type TEXT,
    client_id UUID REFERENCES clients(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS event_log (
    id BIGSERIAL PRIMARY KEY,
    event_uuid UUID NOT NULL DEFAULT gen_random_uuid(),
    event_time TIMESTAMPTZ NOT NULL,
    event_type_code TEXT NOT NULL REFERENCES event_types(code),
    object_type_code TEXT NOT NULL REFERENCES object_types(code),
    client_id UUID NOT NULL REFERENCES clients(id),
    supply_id UUID REFERENCES supplies(id),
    cargo_place_id UUID REFERENCES cargo_places(id),
    product_id UUID REFERENCES products(id),
    barcode_id UUID REFERENCES barcodes(id),
    barcode_before_id UUID REFERENCES barcodes(id),
    barcode_after_id UUID REFERENCES barcodes(id),
    qty NUMERIC(18, 3),
    effect_type_code TEXT REFERENCES effect_types(code),
    item_status_before_code TEXT REFERENCES item_statuses(code),
    item_status_after_code TEXT REFERENCES item_statuses(code),
    box_id UUID REFERENCES boxes(id),
    box_id_from UUID REFERENCES boxes(id),
    box_id_to UUID REFERENCES boxes(id),
    box_status_before_code TEXT REFERENCES box_statuses(code),
    box_status_after_code TEXT REFERENCES box_statuses(code),
    box_type_code TEXT REFERENCES box_types(code),
    location_from_id UUID REFERENCES locations(id),
    location_to_id UUID REFERENCES locations(id),
    correction_reason_code TEXT REFERENCES correction_reasons(code),
    reference_id TEXT,
    document_id UUID REFERENCES documents(id),
    employee_id UUID REFERENCES employees(id),
    comment TEXT,
    payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_event_log_event_uuid UNIQUE (event_uuid)
);

CREATE INDEX IF NOT EXISTS idx_event_log_event_time ON event_log (event_time DESC);
CREATE INDEX IF NOT EXISTS idx_event_log_event_type ON event_log (event_type_code);
CREATE INDEX IF NOT EXISTS idx_event_log_client_time ON event_log (client_id, event_time DESC);
CREATE INDEX IF NOT EXISTS idx_event_log_barcode_time ON event_log (barcode_id, event_time DESC);
CREATE INDEX IF NOT EXISTS idx_event_log_box_time ON event_log (box_id, event_time DESC);
CREATE INDEX IF NOT EXISTS idx_event_log_box_from_time ON event_log (box_id_from, event_time DESC);
CREATE INDEX IF NOT EXISTS idx_event_log_box_to_time ON event_log (box_id_to, event_time DESC);
CREATE INDEX IF NOT EXISTS idx_event_log_supply_time ON event_log (supply_id, event_time DESC);

CREATE TABLE IF NOT EXISTS event_validation_errors (
    id BIGSERIAL PRIMARY KEY,
    event_id BIGINT NOT NULL REFERENCES event_log(id) ON DELETE CASCADE,
    error_code TEXT NOT NULL,
    error_message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE VIEW vw_event_log_human AS
SELECT
    e.id,
    e.event_uuid,
    e.event_time,
    et.name AS event_type,
    ot.name AS object_type,
    c.name AS client,
    s.external_ref AS supply_ref,
    cp.external_ref AS cargo_place_ref,
    p.client_sku,
    b.barcode,
    bb.barcode AS barcode_before,
    ba.barcode AS barcode_after,
    e.qty,
    ef.name AS effect_type,
    isb.name AS item_status_before,
    isa.name AS item_status_after,
    bx.box_code AS box_code,
    bxf.box_code AS box_from,
    bxt.box_code AS box_to,
    bsb.name AS box_status_before,
    bsa.name AS box_status_after,
    bt.name AS box_type,
    lf.code AS location_from,
    lt.code AS location_to,
    cr.name AS correction_reason,
    e.reference_id,
    d.document_ref,
    emp.full_name AS employee,
    e.comment,
    e.payload_json,
    e.created_at
FROM event_log e
JOIN event_types et ON et.code = e.event_type_code
JOIN object_types ot ON ot.code = e.object_type_code
JOIN clients c ON c.id = e.client_id
LEFT JOIN supplies s ON s.id = e.supply_id
LEFT JOIN cargo_places cp ON cp.id = e.cargo_place_id
LEFT JOIN products p ON p.id = e.product_id
LEFT JOIN barcodes b ON b.id = e.barcode_id
LEFT JOIN barcodes bb ON bb.id = e.barcode_before_id
LEFT JOIN barcodes ba ON ba.id = e.barcode_after_id
LEFT JOIN effect_types ef ON ef.code = e.effect_type_code
LEFT JOIN item_statuses isb ON isb.code = e.item_status_before_code
LEFT JOIN item_statuses isa ON isa.code = e.item_status_after_code
LEFT JOIN boxes bx ON bx.id = e.box_id
LEFT JOIN boxes bxf ON bxf.id = e.box_id_from
LEFT JOIN boxes bxt ON bxt.id = e.box_id_to
LEFT JOIN box_statuses bsb ON bsb.code = e.box_status_before_code
LEFT JOIN box_statuses bsa ON bsa.code = e.box_status_after_code
LEFT JOIN box_types bt ON bt.code = e.box_type_code
LEFT JOIN locations lf ON lf.id = e.location_from_id
LEFT JOIN locations lt ON lt.id = e.location_to_id
LEFT JOIN correction_reasons cr ON cr.code = e.correction_reason_code
LEFT JOIN documents d ON d.id = e.document_id
LEFT JOIN employees emp ON emp.id = e.employee_id;

CREATE OR REPLACE VIEW vw_barcode_balances AS
SELECT
    b.barcode,
    p.client_sku,
    c.name AS client,
    COALESCE(SUM(
        CASE e.effect_type_code
            WHEN 'plus' THEN COALESCE(e.qty, 0)
            WHEN 'minus' THEN COALESCE(e.qty, 0) * -1
            ELSE 0
        END
    ), 0) AS qty_balance
FROM barcodes b
JOIN products p ON p.id = b.product_id
JOIN clients c ON c.id = p.client_id
LEFT JOIN event_log e ON e.barcode_id = b.id
GROUP BY b.barcode, p.client_sku, c.name;

CREATE OR REPLACE VIEW vw_box_contents_current AS
SELECT
    bx.box_code,
    b.barcode,
    p.client_sku,
    c.name AS client,
    COALESCE(SUM(
        CASE e.effect_type_code
            WHEN 'plus' THEN COALESCE(e.qty, 0)
            WHEN 'minus' THEN COALESCE(e.qty, 0) * -1
            ELSE 0
        END
    ), 0) AS qty_in_box
FROM event_log e
JOIN boxes bx ON bx.id = COALESCE(e.box_id_to, e.box_id, e.box_id_from)
JOIN barcodes b ON b.id = e.barcode_id
JOIN products p ON p.id = b.product_id
JOIN clients c ON c.id = e.client_id
WHERE e.barcode_id IS NOT NULL
  AND COALESCE(e.box_id_to, e.box_id, e.box_id_from) IS NOT NULL
GROUP BY bx.box_code, b.barcode, p.client_sku, c.name
HAVING COALESCE(SUM(
    CASE e.effect_type_code
        WHEN 'plus' THEN COALESCE(e.qty, 0)
        WHEN 'minus' THEN COALESCE(e.qty, 0) * -1
        ELSE 0
    END
), 0) <> 0;
