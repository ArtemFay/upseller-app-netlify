SET search_path TO wms, public;

INSERT INTO object_types (code, name) VALUES
    ('item', 'Товар'),
    ('box', 'Короб'),
    ('item_box', 'Товар и короб'),
    ('supply', 'Поставка'),
    ('cargo_place', 'Грузоместо'),
    ('inventory', 'Инвентаризация'),
    ('system', 'Системное событие')
ON CONFLICT (code) DO NOTHING;

INSERT INTO effect_types (code, name) VALUES
    ('plus', 'Плюс'),
    ('minus', 'Минус'),
    ('no_effect', 'Не влияет'),
    ('status_transfer', 'Перевод между статусами'),
    ('box_transfer', 'Перевод между коробами')
ON CONFLICT (code) DO NOTHING;

INSERT INTO correction_reasons (code, name) VALUES
    ('receiving', 'Приемка'),
    ('packing', 'Упаковка'),
    ('relabeling', 'Перемаркировка'),
    ('inventory', 'Инвентаризация'),
    ('defect', 'Брак'),
    ('shipment', 'Отгрузка'),
    ('employee_error', 'Ошибка сотрудника'),
    ('system_fix', 'Системная корректировка'),
    ('manual', 'Ручная правка'),
    ('other', 'Прочее')
ON CONFLICT (code) DO NOTHING;

INSERT INTO box_types (code, name) VALUES
    ('receiving_box', 'Короб приемки'),
    ('storage_box', 'Короб хранения'),
    ('packing_box', 'Короб упаковки'),
    ('picking_box', 'Короб отбора'),
    ('shipping_box', 'Короб отгрузки'),
    ('mix_box', 'Микс-короб'),
    ('temp_box', 'Временный короб')
ON CONFLICT (code) DO NOTHING;

INSERT INTO item_statuses (code, name, sort_order) VALUES
    ('draft', 'Черновик', 10),
    ('expected', 'Ожидается', 20),
    ('accepted', 'Принят', 30),
    ('inspection', 'На проверке', 40),
    ('packing', 'На упаковке', 50),
    ('packed', 'Упакован', 60),
    ('storage', 'На хранении', 70),
    ('reserved', 'В резерве', 80),
    ('ready_to_ship', 'Подготовлен к отгрузке', 90),
    ('shipped', 'Отгружен', 100),
    ('defect', 'Брак', 110),
    ('disposed', 'Утилизирован', 120),
    ('returned', 'Возвращен клиенту', 130),
    ('corrected', 'Корректировка', 140)
ON CONFLICT (code) DO NOTHING;

INSERT INTO box_statuses (code, name, sort_order) VALUES
    ('created', 'Создан', 10),
    ('opened', 'Открыт', 20),
    ('closed', 'Закрыт', 30),
    ('receiving', 'На приемке', 40),
    ('packing', 'На упаковке', 50),
    ('storage', 'На хранении', 60),
    ('picking', 'В отборе', 70),
    ('reserved', 'В резерве', 80),
    ('ready_to_ship', 'Подготовлен к отгрузке', 90),
    ('shipped', 'Отгружен', 100),
    ('disassembled', 'Расформирован', 110),
    ('archived', 'Архив', 120)
ON CONFLICT (code) DO NOTHING;

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
    ('supply_request_created', 'Создана заявка на поставку', 'supply', FALSE, FALSE, FALSE, FALSE, FALSE, 'no_effect', TRUE, 'Основание для приемки'),
    ('supply_arrived', 'Поставка прибыла', 'supply', FALSE, FALSE, FALSE, FALSE, FALSE, 'no_effect', TRUE, 'Факт прибытия поставки'),
    ('cargo_unloaded', 'Разгружены грузоместа', 'cargo_place', FALSE, FALSE, FALSE, FALSE, FALSE, 'no_effect', TRUE, 'Физическая разгрузка'),
    ('cargo_opened', 'Вскрыто грузоместо', 'cargo_place', FALSE, FALSE, FALSE, FALSE, FALSE, 'no_effect', TRUE, 'Начало приемки'),
    ('item_received', 'Принят товар поштучно', 'item_box', TRUE, TRUE, TRUE, TRUE, TRUE, 'plus', TRUE, 'Ставит товар на баланс'),
    ('receiving_surplus', 'Обнаружен излишек при приемке', 'item', TRUE, FALSE, FALSE, FALSE, FALSE, 'plus', TRUE, 'Излишек по факту'),
    ('receiving_shortage', 'Обнаружена недостача при приемке', 'item', TRUE, FALSE, FALSE, FALSE, FALSE, 'minus', TRUE, 'Недостача по факту'),
    ('receiving_defect', 'Обнаружен брак при приемке', 'item', FALSE, FALSE, FALSE, TRUE, FALSE, 'status_transfer', TRUE, 'Перевод в брак'),
    ('internal_label_applied', 'Товар промаркирован внутренним штрихкодом', 'item', FALSE, FALSE, FALSE, FALSE, FALSE, 'no_effect', TRUE, 'Привязка внутреннего баркода'),
    ('box_created', 'Создан короб', 'box', FALSE, TRUE, FALSE, FALSE, TRUE, 'no_effect', TRUE, 'Создание контейнера'),
    ('box_opened', 'Короб открыт', 'box', FALSE, TRUE, FALSE, FALSE, TRUE, 'no_effect', FALSE, 'Открытие короба'),
    ('box_closed', 'Короб закрыт', 'box', FALSE, TRUE, FALSE, FALSE, TRUE, 'no_effect', FALSE, 'Закрытие короба'),
    ('item_put_into_box', 'Товар добавлен в короб', 'item_box', FALSE, TRUE, TRUE, FALSE, FALSE, 'box_transfer', TRUE, 'Увеличивает состав короба'),
    ('item_taken_from_box', 'Товар извлечен из короба', 'item_box', FALSE, TRUE, TRUE, FALSE, FALSE, 'box_transfer', TRUE, 'Уменьшает состав короба'),
    ('box_moved', 'Короб перемещен', 'box', FALSE, TRUE, FALSE, FALSE, FALSE, 'no_effect', TRUE, 'Меняет адрес короба'),
    ('box_stored', 'Короб размещен на хранение', 'box', FALSE, TRUE, FALSE, FALSE, TRUE, 'no_effect', TRUE, 'Назначение адреса хранения'),
    ('item_stored', 'Товар поставлен на хранение', 'item', FALSE, FALSE, FALSE, TRUE, FALSE, 'status_transfer', TRUE, 'Перевод в хранение'),
    ('item_removed_from_storage', 'Товар снят с хранения', 'item', FALSE, FALSE, FALSE, TRUE, FALSE, 'status_transfer', TRUE, 'Снятие с хранения'),
    ('packing_started', 'Начата упаковка', 'item_box', FALSE, TRUE, FALSE, TRUE, TRUE, 'status_transfer', TRUE, 'Переход в упаковку'),
    ('item_packed', 'Товар упакован', 'item', FALSE, FALSE, FALSE, TRUE, FALSE, 'status_transfer', TRUE, 'Упаковка завершена'),
    ('label_applied', 'Наклеена этикетка', 'item', FALSE, FALSE, FALSE, FALSE, FALSE, 'no_effect', TRUE, 'Этикетка наклеена'),
    ('packing_defect', 'Обнаружен брак при упаковке', 'item', FALSE, FALSE, FALSE, TRUE, FALSE, 'status_transfer', TRUE, 'Брак на упаковке'),
    ('barcode_removed', 'Снят старый штрихкод', 'item', TRUE, FALSE, FALSE, FALSE, FALSE, 'minus', TRUE, 'Старый баркод убывает'),
    ('barcode_applied', 'Наклеен новый штрихкод', 'item', TRUE, FALSE, FALSE, FALSE, FALSE, 'plus', TRUE, 'Новый баркод появляется'),
    ('item_relabelled', 'Товар перемаркирован', 'item', TRUE, FALSE, TRUE, FALSE, FALSE, 'no_effect', TRUE, 'Пара плюс/минус в детализации'),
    ('picking_started', 'Начат подбор', 'item', FALSE, FALSE, FALSE, TRUE, FALSE, 'status_transfer', TRUE, 'Товар уходит в подбор'),
    ('item_reserved', 'Товар зарезервирован', 'item', FALSE, FALSE, FALSE, TRUE, FALSE, 'status_transfer', TRUE, 'Резерв товара'),
    ('shipping_box_created', 'Создан короб отгрузки', 'box', FALSE, TRUE, FALSE, FALSE, TRUE, 'no_effect', TRUE, 'Контейнер отгрузки'),
    ('item_put_into_shipping_box', 'Товар помещен в короб отгрузки', 'item_box', FALSE, TRUE, TRUE, TRUE, FALSE, 'box_transfer', TRUE, 'Товар меняет короб и статус'),
    ('picking_finished', 'Подбор завершен', 'system', FALSE, FALSE, FALSE, FALSE, FALSE, 'no_effect', TRUE, 'Фиксация завершения подбора'),
    ('box_ready_to_ship', 'Короб подготовлен к отгрузке', 'box', FALSE, TRUE, FALSE, FALSE, TRUE, 'no_effect', TRUE, 'Короб готов к отгрузке'),
    ('box_shipped', 'Короб отгружен', 'box', TRUE, TRUE, TRUE, TRUE, TRUE, 'minus', TRUE, 'Короб покинул склад'),
    ('item_shipped', 'Товар отгружен поштучно', 'item', TRUE, FALSE, FALSE, TRUE, FALSE, 'minus', TRUE, 'Поштучная отгрузка'),
    ('shipment_cancelled', 'Отгрузка отменена', 'system', FALSE, FALSE, FALSE, FALSE, FALSE, 'no_effect', TRUE, 'Отмена отгрузки'),
    ('item_marked_defect', 'Товар признан браком', 'item', FALSE, FALSE, FALSE, TRUE, FALSE, 'status_transfer', TRUE, 'Перевод в брак'),
    ('defect_returned', 'Брак возвращен клиенту', 'item', TRUE, FALSE, FALSE, TRUE, FALSE, 'minus', TRUE, 'Брак убыл со склада'),
    ('defect_disposed', 'Брак утилизирован', 'item', TRUE, FALSE, FALSE, TRUE, FALSE, 'minus', TRUE, 'Брак списан'),
    ('inventory_started', 'Начата инвентаризация', 'inventory', FALSE, FALSE, FALSE, FALSE, FALSE, 'no_effect', TRUE, 'Старт инвентаризации'),
    ('inventory_counted', 'Проведен пересчет', 'inventory', FALSE, FALSE, FALSE, FALSE, FALSE, 'no_effect', TRUE, 'Фиксация пересчета'),
    ('inventory_gap_found', 'Обнаружено расхождение', 'inventory', FALSE, FALSE, FALSE, FALSE, FALSE, 'no_effect', TRUE, 'Факт расхождения'),
    ('shortage_written_off', 'Списана недостача', 'item', TRUE, FALSE, FALSE, TRUE, FALSE, 'minus', TRUE, 'Списание недостачи'),
    ('surplus_posted', 'Оприходован излишек', 'item', TRUE, FALSE, FALSE, TRUE, FALSE, 'plus', TRUE, 'Оприходование излишка'),
    ('manual_qty_fix', 'Ручная корректировка остатка', 'item', TRUE, FALSE, FALSE, FALSE, FALSE, 'no_effect', TRUE, 'Ручное изменение количества'),
    ('manual_status_fix', 'Ручная корректировка статуса', 'item', FALSE, FALSE, FALSE, TRUE, FALSE, 'status_transfer', TRUE, 'Ручная смена статуса'),
    ('accounting_error_fix', 'Исправление ошибки учета', 'system', FALSE, FALSE, FALSE, FALSE, FALSE, 'no_effect', TRUE, 'Компенсирующее исправление'),
    ('box_split', 'Короб разделен', 'box', FALSE, TRUE, TRUE, FALSE, TRUE, 'box_transfer', TRUE, 'Один короб разделен на несколько'),
    ('boxes_merged', 'Коробы объединены', 'box', FALSE, TRUE, TRUE, FALSE, TRUE, 'box_transfer', TRUE, 'Несколько коробов объединены'),
    ('box_compacted', 'Короб уплотнен', 'box', FALSE, TRUE, TRUE, FALSE, TRUE, 'box_transfer', TRUE, 'Пересборка состава коробов')
ON CONFLICT (code) DO NOTHING;

INSERT INTO clients (code, name) VALUES
    ('client_a', 'Клиент А')
ON CONFLICT (code) DO NOTHING;

INSERT INTO employees (code, full_name, role_name) VALUES
    ('emp_001', 'Сотрудник 1', 'Оператор'),
    ('emp_002', 'Сотрудник 2', 'Оператор'),
    ('emp_003', 'Сотрудник 3', 'Старший смены')
ON CONFLICT (code) DO NOTHING;

INSERT INTO locations (code, zone_name, description) VALUES
    ('A-01-04', 'Хранение', 'Ячейка A-01-04'),
    ('A-02-05', 'Хранение', 'Ячейка A-02-05'),
    ('A-03-06', 'Упаковка', 'Ячейка A-03-06'),
    ('SHIP-01', 'Отгрузка', 'Зона отгрузки'),
    ('ARCH-01', 'Архив', 'Архив коробов')
ON CONFLICT (code) DO NOTHING;

INSERT INTO supplies (external_ref, client_id, status_name)
SELECT 'SUP-1001', c.id, 'created'
FROM clients c
WHERE c.code = 'client_a'
ON CONFLICT (external_ref) DO NOTHING;

INSERT INTO products (client_id, client_sku, product_name)
SELECT c.id, x.client_sku, x.product_name
FROM clients c
JOIN (
    VALUES
        ('SKU-001', 'Товар 1'),
        ('SKU-002', 'Товар 2'),
        ('SKU-003', 'Товар 3'),
        ('SKU-004', 'Товар 4')
) AS x(client_sku, product_name) ON TRUE
WHERE c.code = 'client_a'
ON CONFLICT (client_id, client_sku) DO NOTHING;

INSERT INTO barcodes (product_id, barcode, barcode_kind)
SELECT p.id, x.barcode, 'client'
FROM products p
JOIN (
    VALUES
        ('SKU-001', 'BC-0001'),
        ('SKU-002', 'BC-0002'),
        ('SKU-003', 'BC-0003'),
        ('SKU-004', 'BC-0004')
) AS x(client_sku, barcode) ON x.client_sku = p.client_sku
ON CONFLICT (barcode) DO NOTHING;

INSERT INTO boxes (box_code, client_id, box_type_code, current_status_code, current_location_id)
SELECT x.box_code, c.id, x.box_type_code, x.status_code, l.id
FROM clients c
JOIN (
    VALUES
        ('BX-001', 'storage_box', 'storage', 'A-01-04'),
        ('BX-002', 'shipping_box', 'ready_to_ship', 'SHIP-01'),
        ('BX-003', 'packing_box', 'opened', 'A-03-06')
) AS x(box_code, box_type_code, status_code, location_code) ON TRUE
JOIN locations l ON l.code = x.location_code
WHERE c.code = 'client_a'
ON CONFLICT (box_code) DO NOTHING;

WITH refs AS (
    SELECT
        c.id AS client_id,
        s.id AS supply_id,
        e.id AS employee_id,
        p.id AS product_id,
        b.id AS barcode_id,
        bx.id AS box_id,
        l.id AS location_id
    FROM clients c
    JOIN supplies s ON s.client_id = c.id AND s.external_ref = 'SUP-1001'
    JOIN employees e ON e.code = 'emp_001'
    JOIN products p ON p.client_id = c.id AND p.client_sku = 'SKU-001'
    JOIN barcodes b ON b.product_id = p.id AND b.barcode = 'BC-0001'
    JOIN boxes bx ON bx.box_code = 'BX-001'
    JOIN locations l ON l.code = 'A-01-04'
    WHERE c.code = 'client_a'
)
INSERT INTO event_log (
    event_time,
    event_type_code,
    object_type_code,
    client_id,
    supply_id,
    product_id,
    barcode_id,
    qty,
    effect_type_code,
    item_status_after_code,
    box_id,
    box_status_after_code,
    box_type_code,
    location_to_id,
    reference_id,
    employee_id,
    comment
)
SELECT
    TIMESTAMPTZ '2026-03-14 10:00:00+04',
    'item_received',
    'item_box',
    client_id,
    supply_id,
    product_id,
    barcode_id,
    50,
    'plus',
    'accepted',
    box_id,
    'storage',
    'storage_box',
    location_id,
    'REP-REC-001',
    employee_id,
    'Тестовая приемка товара в локальной базе'
FROM refs
WHERE NOT EXISTS (
    SELECT 1
    FROM event_log
    WHERE reference_id = 'REP-REC-001'
);

WITH ctx AS (
    SELECT
        c.id AS client_id,
        s.id AS supply_id,
        e1.id AS emp1_id,
        e2.id AS emp2_id,
        p1.id AS product1_id,
        p2.id AS product2_id,
        bc1.id AS bc1_id,
        bc2.id AS bc2_id,
        bx1.id AS bx1_id,
        bx2.id AS bx2_id,
        bx3.id AS bx3_id,
        l_storage.id AS loc_storage_id,
        l_ship.id AS loc_ship_id
    FROM clients c
    JOIN supplies s ON s.client_id = c.id AND s.external_ref = 'SUP-1001'
    JOIN employees e1 ON e1.code = 'emp_001'
    JOIN employees e2 ON e2.code = 'emp_002'
    JOIN products p1 ON p1.client_id = c.id AND p1.client_sku = 'SKU-001'
    JOIN products p2 ON p2.client_id = c.id AND p2.client_sku = 'SKU-002'
    JOIN barcodes bc1 ON bc1.product_id = p1.id AND bc1.barcode = 'BC-0001'
    JOIN barcodes bc2 ON bc2.product_id = p2.id AND bc2.barcode = 'BC-0002'
    JOIN boxes bx1 ON bx1.box_code = 'BX-001'
    JOIN boxes bx2 ON bx2.box_code = 'BX-002'
    JOIN boxes bx3 ON bx3.box_code = 'BX-003'
    JOIN locations l_storage ON l_storage.code = 'A-01-04'
    JOIN locations l_ship ON l_ship.code = 'SHIP-01'
    WHERE c.code = 'client_a'
)
INSERT INTO event_log (
    event_time,
    event_type_code,
    object_type_code,
    client_id,
    supply_id,
    product_id,
    barcode_id,
    qty,
    effect_type_code,
    item_status_before_code,
    item_status_after_code,
    box_id,
    box_id_from,
    box_id_to,
    box_status_before_code,
    box_status_after_code,
    box_type_code,
    location_from_id,
    location_to_id,
    reference_id,
    employee_id,
    comment,
    payload_json
)
SELECT *
FROM (
    SELECT
        TIMESTAMPTZ '2026-03-14 10:30:00+04',
        'item_received',
        'item_box',
        client_id,
        supply_id,
        product2_id,
        bc2_id,
        20::NUMERIC,
        'plus',
        NULL::TEXT,
        'accepted',
        bx1_id,
        NULL::UUID,
        bx1_id,
        NULL::TEXT,
        'storage',
        'storage_box',
        NULL::UUID,
        loc_storage_id,
        'REP-REC-002',
        emp1_id,
        'Тестовая приемка второго баркода в короб BX-001',
        '{"report_type":"receiving"}'::jsonb
    FROM ctx

    UNION ALL

    SELECT
        TIMESTAMPTZ '2026-03-14 11:00:00+04',
        'box_moved',
        'box',
        client_id,
        supply_id,
        NULL::UUID,
        NULL::UUID,
        NULL::NUMERIC,
        'no_effect',
        NULL::TEXT,
        NULL::TEXT,
        bx1_id,
        NULL::UUID,
        NULL::UUID,
        'storage',
        'storage',
        'storage_box',
        loc_storage_id,
        loc_ship_id,
        'REP-MOVE-001',
        emp2_id,
        'Тестовое перемещение короба BX-001 в зону отгрузки',
        '{"report_type":"box_move","boxes_count":1}'::jsonb
    FROM ctx

    UNION ALL

    SELECT
        TIMESTAMPTZ '2026-03-14 11:15:00+04',
        'item_stored',
        'item',
        client_id,
        supply_id,
        product1_id,
        bc1_id,
        50::NUMERIC,
        'status_transfer',
        'accepted',
        'storage',
        bx1_id,
        NULL::UUID,
        NULL::UUID,
        NULL::TEXT,
        NULL::TEXT,
        'storage_box',
        NULL::UUID,
        loc_storage_id,
        'REP-STO-001',
        emp2_id,
        'Тестовая постановка товара на хранение',
        '{"report_type":"storage"}'::jsonb
    FROM ctx

    UNION ALL

    SELECT
        TIMESTAMPTZ '2026-03-14 12:00:00+04',
        'shipping_box_created',
        'box',
        client_id,
        NULL::UUID,
        NULL::UUID,
        NULL::UUID,
        NULL::NUMERIC,
        'no_effect',
        NULL::TEXT,
        NULL::TEXT,
        bx2_id,
        NULL::UUID,
        NULL::UUID,
        NULL::TEXT,
        'created',
        'shipping_box',
        NULL::UUID,
        loc_ship_id,
        'REP-SHIPBOX-001',
        emp1_id,
        'Тестовое создание короба отгрузки BX-002',
        '{"report_type":"shipment_prepare"}'::jsonb
    FROM ctx

    UNION ALL

    SELECT
        TIMESTAMPTZ '2026-03-14 12:15:00+04',
        'item_put_into_shipping_box',
        'item_box',
        client_id,
        NULL,
        product1_id,
        bc1_id,
        10::NUMERIC,
        'box_transfer',
        'storage',
        'ready_to_ship',
        bx2_id,
        bx1_id,
        bx2_id,
        'storage',
        'created',
        'shipping_box',
        loc_storage_id,
        loc_ship_id,
        'REP-SHIPBOX-002',
        emp1_id,
        'Тестовая перекладка части товара в короб отгрузки',
        '{"report_type":"shipment_prepare","source_box":"BX-001","target_box":"BX-002"}'::jsonb
    FROM ctx

    UNION ALL

    SELECT
        TIMESTAMPTZ '2026-03-14 13:00:00+04',
        'box_shipped',
        'box',
        client_id,
        NULL::UUID,
        NULL::UUID,
        NULL::UUID,
        NULL::NUMERIC,
        'minus',
        NULL::TEXT,
        NULL::TEXT,
        bx2_id,
        NULL::UUID,
        NULL::UUID,
        'ready_to_ship',
        'shipped',
        'shipping_box',
        loc_ship_id,
        NULL::UUID,
        'REP-SHIP-001',
        emp2_id,
        'Тестовая отгрузка короба BX-002',
        '{"report_type":"shipment","destination":"marketplace"}'::jsonb
    FROM ctx
) AS demo_events (
    event_time,
    event_type_code,
    object_type_code,
    client_id,
    supply_id,
    product_id,
    barcode_id,
    qty,
    effect_type_code,
    item_status_before_code,
    item_status_after_code,
    box_id,
    box_id_from,
    box_id_to,
    box_status_before_code,
    box_status_after_code,
    box_type_code,
    location_from_id,
    location_to_id,
    reference_id,
    employee_id,
    comment,
    payload_json
)
WHERE NOT EXISTS (
    SELECT 1
    FROM event_log e
    WHERE e.reference_id = demo_events.reference_id
);
