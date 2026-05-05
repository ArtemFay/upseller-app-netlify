-- =============================================================
-- 003_picking.sql — расширение схемы под модуль «Подборы»
-- =============================================================
-- Запускается ПОСЛЕ 001_schema.sql и 002_seed.sql.
-- Идемпотентен (IF NOT EXISTS / ON CONFLICT DO NOTHING).
--
-- Что добавляет:
--  1. Таблица picking_requests — заявка на подбор (S<NNNN> / R<NNNN>).
--  2. ALTER event_log: ссылка picking_request_id и поле pick_mode.
--  3. Новые event_types для подбора:
--       picking_zayavka_started, picking_zayavka_unlocked,
--       picking_zayavka_finalized, picking_zayavka_partial_close,
--       shipping_box_deleted, picking_layout_saved,
--       picking_full_box_taken.
--  4. Новые object_types: 'picking_request'.
--  5. Новый item_status: 'partial' (для частично собранных заявок).
--  6. View vw_picking_request_history — история одной заявки.
-- =============================================================

SET search_path TO wms, public;

-- 1. Таблица picking_requests --------------------------------------------------

CREATE TABLE IF NOT EXISTS picking_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_code    TEXT NOT NULL UNIQUE,            -- 'S1294-Видинеева' / 'R0053-...'
    request_type    TEXT NOT NULL,                   -- 'OTG' (отгрузка) | 'PER' (перемаркировка)
    pick_mode       TEXT NOT NULL,                   -- 'SVOB' (СВОБ) | 'KOR' (КОР) | 'KOR_PLUS' (КОР+)
    client_id       UUID NOT NULL REFERENCES clients(id),
    ks              NUMERIC(4,2) NOT NULL DEFAULT 1, -- коэффициент сложности
    skus_count      INTEGER NOT NULL DEFAULT 0,
    units_total     INTEGER NOT NULL DEFAULT 0,
    status_code     TEXT NOT NULL DEFAULT 'created', -- created | in_progress | partial | finalized | cancelled
    locked_by_id    UUID REFERENCES employees(id),   -- кто сейчас держит заявку
    locked_at       TIMESTAMPTZ,
    finalized_at    TIMESTAMPTZ,
    sheet_row_ref   INTEGER,                         -- # строки в БД_ЭКСП (для синхронизации)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_request_type CHECK (request_type IN ('OTG', 'PER')),
    CONSTRAINT chk_pick_mode    CHECK (pick_mode    IN ('SVOB', 'KOR', 'KOR_PLUS')),
    CONSTRAINT chk_status       CHECK (status_code  IN ('created','in_progress','partial','finalized','cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_picking_requests_client    ON picking_requests (client_id);
CREATE INDEX IF NOT EXISTS idx_picking_requests_status    ON picking_requests (status_code);
CREATE INDEX IF NOT EXISTS idx_picking_requests_locked_by ON picking_requests (locked_by_id) WHERE locked_by_id IS NOT NULL;

-- 2. Расширение event_log -----------------------------------------------------

ALTER TABLE event_log
    ADD COLUMN IF NOT EXISTS picking_request_id UUID REFERENCES picking_requests(id);

CREATE INDEX IF NOT EXISTS idx_event_log_picking_request_time
    ON event_log (picking_request_id, event_time DESC)
    WHERE picking_request_id IS NOT NULL;

-- 3. Object type для заявки ----------------------------------------------------

INSERT INTO object_types (code, name) VALUES
    ('picking_request', 'Заявка на подбор')
ON CONFLICT (code) DO NOTHING;

-- 4. Дополнительный статус товара ---------------------------------------------

INSERT INTO item_statuses (code, name, sort_order) VALUES
    ('partial_picked', 'Частично собран', 95)
ON CONFLICT (code) DO NOTHING;

-- 5. Новые event_types для Подбора --------------------------------------------

INSERT INTO event_types (
    code,
    name,
    object_type_code,
    affects_inventory,
    affects_box_state,
    affects_box_content,
    affects_item_status,
    affects_box_status,
    default_effect_type_code,
    is_report_level,
    notes
) VALUES
    ('picking_zayavka_started',       'Заявка взята в работу',                 'picking_request', FALSE, FALSE, FALSE, FALSE, FALSE, 'no_effect',      TRUE,  'Подборщик захватил lock на заявку. Меняет picking_requests.status_code на in_progress, locked_by_id, locked_at.'),
    ('picking_zayavka_unlocked',      'Заявка освобождена без финализации',     'picking_request', FALSE, FALSE, FALSE, FALSE, FALSE, 'no_effect',      TRUE,  'Подборщик отказался от заявки. Снимает lock, возвращает status_code → created (если черновик пуст) либо partial.'),
    ('picking_zayavka_finalized',     'Заявка успешно финализирована',          'picking_request', FALSE, FALSE, FALSE, FALSE, FALSE, 'no_effect',      TRUE,  'Транзакция 4 шагов (КОРОБЫ + ОТГ + НАЧ + БД) прошла успешно. Сводное событие верхнего уровня; детали — в составляющих item_taken_from_box / item_put_into_shipping_box / shortage_written_off / etc.'),
    ('picking_zayavka_partial_close', 'Заявка закрыта частично',                'picking_request', FALSE, FALSE, FALSE, FALSE, FALSE, 'no_effect',      TRUE,  'Финализация со статусом ЧАСТИЧНО СОБРАНА. payload_json несёт причину и недостающие баркоды.'),
    ('shipping_box_deleted',          'Удалён неиспользованный короб отгрузки', 'box',             FALSE, TRUE,  FALSE, FALSE, TRUE,  'no_effect',      FALSE, 'Подборщик удалил пустой короб до использования. Симметрично shipping_box_created.'),
    ('picking_layout_saved',          'Сохранена раскладка короба',             'item_box',        FALSE, FALSE, FALSE, FALSE, FALSE, 'no_effect',      FALSE, 'Снимок намерения подборщика по одному коробу-источнику (kolPodb / kudaPodb / kolPerem / kudaPerem). До финализации физически в КОРОБЫ ничего не пишется. На finalize этот snapshot разворачивается в item_taken_from_box + item_put_into_shipping_box.'),
    ('picking_full_box_taken',        'Короб взят целиком',                     'item_box',        FALSE, TRUE,  TRUE,  TRUE,  TRUE,  'box_transfer',   TRUE,  'ПОЛН КОРОБ: исходный K-короб целиком становится S-коробом отгрузки (kolPodb=qty для всех строк). Спец-случай picking_layout_saved для UX/отчётности.'),
    ('accounting_accrual_created',    'Создано начисление за подбор',           'system',          FALSE, FALSE, FALSE, FALSE, FALSE, 'no_effect',      TRUE,  'Append в НАЧИСЛЕНИЯ.НАЧ. payload_json несёт actor, сумму, КС, основание (заявка).')
ON CONFLICT (code) DO NOTHING;

-- 6. View истории заявки --------------------------------------------------------

CREATE OR REPLACE VIEW vw_picking_request_history AS
SELECT
    pr.request_code,
    pr.request_type,
    pr.pick_mode,
    pr.status_code,
    e.event_time,
    et.name           AS event_type,
    emp.full_name     AS employee,
    bx.box_code       AS box_code,
    b.barcode         AS barcode,
    e.qty,
    ef.name           AS effect_type,
    bxf.box_code      AS box_from,
    bxt.box_code      AS box_to,
    e.comment,
    e.payload_json
FROM picking_requests pr
JOIN event_log e            ON e.picking_request_id = pr.id
JOIN event_types et         ON et.code = e.event_type_code
LEFT JOIN employees emp     ON emp.id  = e.employee_id
LEFT JOIN boxes bx          ON bx.id   = e.box_id
LEFT JOIN boxes bxf         ON bxf.id  = e.box_id_from
LEFT JOIN boxes bxt         ON bxt.id  = e.box_id_to
LEFT JOIN barcodes b        ON b.id    = e.barcode_id
LEFT JOIN effect_types ef   ON ef.code = e.effect_type_code
ORDER BY pr.request_code, e.event_time;

-- 7. Helper-функция: текущее состояние заявки -----------------------------------

CREATE OR REPLACE FUNCTION fn_picking_request_progress(p_request_code TEXT)
RETURNS TABLE (
    request_code TEXT,
    units_planned INTEGER,
    units_picked NUMERIC,
    units_remaining NUMERIC,
    boxes_used INTEGER,
    last_event_at TIMESTAMPTZ
) AS $$
    SELECT
        pr.request_code,
        pr.units_total,
        COALESCE(SUM(
            CASE WHEN et.code IN ('item_put_into_shipping_box','picking_full_box_taken')
                 THEN COALESCE(e.qty, 0) ELSE 0 END
        ), 0) AS units_picked,
        pr.units_total - COALESCE(SUM(
            CASE WHEN et.code IN ('item_put_into_shipping_box','picking_full_box_taken')
                 THEN COALESCE(e.qty, 0) ELSE 0 END
        ), 0) AS units_remaining,
        COUNT(DISTINCT e.box_id_to) FILTER (WHERE e.box_id_to IS NOT NULL)::INTEGER AS boxes_used,
        MAX(e.event_time) AS last_event_at
    FROM picking_requests pr
    LEFT JOIN event_log e   ON e.picking_request_id = pr.id
    LEFT JOIN event_types et ON et.code = e.event_type_code
    WHERE pr.request_code = p_request_code
    GROUP BY pr.request_code, pr.units_total;
$$ LANGUAGE SQL STABLE;

-- =============================================================
-- Конец 003_picking.sql
-- =============================================================
