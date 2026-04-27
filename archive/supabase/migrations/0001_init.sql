-- ============================================================
-- Upseller Journal of Events — initial schema
-- Append-only event journals + editable reference tables
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- REFERENCE TABLES (editable)
-- ============================================================

CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  inn TEXT,
  status TEXT,
  contact TEXT,
  phone TEXT,
  telegram TEXT,
  gmail TEXT,
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  details JSONB DEFAULT '{}'::jsonb
);

CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  barcode TEXT NOT NULL UNIQUE,
  client_id UUID REFERENCES clients(id),
  client_name TEXT,
  sku TEXT,
  name TEXT,
  color TEXT,
  size TEXT,
  marketplace TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  details JSONB DEFAULT '{}'::jsonb
);

CREATE TABLE employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  email TEXT,
  role TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  details JSONB DEFAULT '{}'::jsonb
);

-- ============================================================
-- HISTORY TABLES (auto-populated by triggers)
-- ============================================================

CREATE TABLE clients_history (
  history_id BIGSERIAL PRIMARY KEY,
  id UUID NOT NULL,
  snapshot JSONB NOT NULL,
  change_type TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE products_history (
  history_id BIGSERIAL PRIMARY KEY,
  id UUID NOT NULL,
  snapshot JSONB NOT NULL,
  change_type TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE employees_history (
  history_id BIGSERIAL PRIMARY KEY,
  id UUID NOT NULL,
  snapshot JSONB NOT NULL,
  change_type TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION log_history()
RETURNS TRIGGER AS $$
DECLARE
  history_table TEXT := TG_TABLE_NAME || '_history';
BEGIN
  IF TG_OP = 'DELETE' THEN
    EXECUTE format(
      'INSERT INTO %I (id, snapshot, change_type) VALUES ($1, $2, $3)',
      history_table
    ) USING OLD.id, to_jsonb(OLD), TG_OP;
    RETURN OLD;
  ELSE
    EXECUTE format(
      'INSERT INTO %I (id, snapshot, change_type) VALUES ($1, $2, $3)',
      history_table
    ) USING NEW.id, to_jsonb(NEW), TG_OP;
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER clients_history_trigger
AFTER INSERT OR UPDATE OR DELETE ON clients
FOR EACH ROW EXECUTE FUNCTION log_history();

CREATE TRIGGER products_history_trigger
AFTER INSERT OR UPDATE OR DELETE ON products
FOR EACH ROW EXECUTE FUNCTION log_history();

CREATE TRIGGER employees_history_trigger
AFTER INSERT OR UPDATE OR DELETE ON employees
FOR EACH ROW EXECUTE FUNCTION log_history();

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER clients_updated_at BEFORE UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER products_updated_at BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER employees_updated_at BEFORE UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- APPEND-ONLY EVENT JOURNALS
-- ============================================================

CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_type TEXT NOT NULL,
  client_id UUID REFERENCES clients(id),
  client_name TEXT,
  request TEXT,
  operator_id UUID REFERENCES employees(id),
  operator_name TEXT,
  employee_id UUID REFERENCES employees(id),
  employee_name TEXT,
  responsible_id UUID REFERENCES employees(id),
  responsible_name TEXT,
  source TEXT NOT NULL,
  source_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  details JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX events_operation_type_idx ON events(operation_type);
CREATE INDEX events_client_id_idx ON events(client_id);
CREATE INDEX events_created_at_idx ON events(created_at DESC);

CREATE TABLE stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id),
  barcode TEXT NOT NULL,
  product_id UUID REFERENCES products(id),
  qty NUMERIC NOT NULL,
  comment TEXT,
  details JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX stock_movements_event_id_idx ON stock_movements(event_id);
CREATE INDEX stock_movements_barcode_idx ON stock_movements(barcode);

CREATE TABLE boxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id),
  box_number TEXT NOT NULL,
  container TEXT,
  status TEXT,
  product_type TEXT,
  address TEXT,
  sku_count INTEGER,
  warehouse TEXT,
  slot TEXT,
  weight_kg NUMERIC,
  fill_pct NUMERIC,
  volume_l NUMERIC,
  marketplace TEXT,
  shipment_num TEXT,
  shipment_date DATE,
  comment TEXT,
  details JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX boxes_event_id_idx ON boxes(event_id);
CREATE INDEX boxes_box_number_idx ON boxes(box_number);

CREATE TABLE box_contents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id),
  box_number TEXT NOT NULL,
  barcode TEXT NOT NULL,
  product_id UUID REFERENCES products(id),
  qty NUMERIC NOT NULL,
  expires_at DATE,
  sku_weight_kg NUMERIC,
  sku_volume_l NUMERIC,
  comment TEXT,
  details JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX box_contents_event_id_idx ON box_contents(event_id);
CREATE INDEX box_contents_box_number_idx ON box_contents(box_number);
CREATE INDEX box_contents_barcode_idx ON box_contents(barcode);

CREATE TABLE charges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id),
  article TEXT NOT NULL,
  destination TEXT,
  box_number TEXT,
  barcode TEXT,
  product_id UUID REFERENCES products(id),
  qty NUMERIC,
  unit_price NUMERIC,
  coef_difficulty NUMERIC,
  sum NUMERIC NOT NULL,
  marketplace TEXT,
  details JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX charges_event_id_idx ON charges(event_id);
CREATE INDEX charges_article_idx ON charges(article);

-- ============================================================
-- APPEND-ONLY ENFORCEMENT (deny UPDATE/DELETE on journals)
-- ============================================================

CREATE OR REPLACE FUNCTION deny_update_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Journal tables are append-only. UPDATE/DELETE is not allowed.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER events_no_modify BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION deny_update_delete();
CREATE TRIGGER stock_movements_no_modify BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION deny_update_delete();
CREATE TRIGGER boxes_no_modify BEFORE UPDATE OR DELETE ON boxes FOR EACH ROW EXECUTE FUNCTION deny_update_delete();
CREATE TRIGGER box_contents_no_modify BEFORE UPDATE OR DELETE ON box_contents FOR EACH ROW EXECUTE FUNCTION deny_update_delete();
CREATE TRIGGER charges_no_modify BEFORE UPDATE OR DELETE ON charges FOR EACH ROW EXECUTE FUNCTION deny_update_delete();

-- ============================================================
-- AUTO-UPSERT HELPERS (reference tables self-populate on write)
-- ============================================================

CREATE OR REPLACE FUNCTION ensure_client(p_name TEXT)
RETURNS UUID AS $$
DECLARE
  v_id UUID;
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RETURN NULL;
  END IF;
  INSERT INTO clients (name) VALUES (btrim(p_name)) ON CONFLICT (name) DO NOTHING;
  SELECT id INTO v_id FROM clients WHERE name = btrim(p_name);
  RETURN v_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ensure_product(p_barcode TEXT, p_client_name TEXT)
RETURNS UUID AS $$
DECLARE
  v_id UUID;
  v_client_id UUID;
BEGIN
  IF p_barcode IS NULL OR btrim(p_barcode) = '' THEN
    RETURN NULL;
  END IF;
  v_client_id := ensure_client(p_client_name);
  INSERT INTO products (barcode, client_id, client_name)
    VALUES (btrim(p_barcode), v_client_id, btrim(p_client_name))
    ON CONFLICT (barcode) DO NOTHING;
  SELECT id INTO v_id FROM products WHERE barcode = btrim(p_barcode);
  RETURN v_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ensure_employee(p_name TEXT)
RETURNS UUID AS $$
DECLARE
  v_id UUID;
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RETURN NULL;
  END IF;
  INSERT INTO employees (name) VALUES (btrim(p_name)) ON CONFLICT (name) DO NOTHING;
  SELECT id INTO v_id FROM employees WHERE name = btrim(p_name);
  RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- VIEWS (derive "current state" from append-only journals)
-- ============================================================

CREATE OR REPLACE VIEW v_current_stock AS
SELECT
  e.client_id,
  e.client_name,
  sm.barcode,
  SUM(sm.qty) AS qty_total,
  MAX(sm.created_at) AS last_movement_at
FROM stock_movements sm
JOIN events e ON e.id = sm.event_id
GROUP BY e.client_id, e.client_name, sm.barcode;

CREATE OR REPLACE VIEW v_current_boxes AS
SELECT DISTINCT ON (b.box_number)
  b.box_number,
  e.client_name,
  b.status,
  b.address,
  b.warehouse,
  b.slot,
  b.weight_kg,
  b.volume_l,
  b.fill_pct,
  e.created_at AS last_updated_at
FROM boxes b
JOIN events e ON e.id = b.event_id
ORDER BY b.box_number, e.created_at DESC;
