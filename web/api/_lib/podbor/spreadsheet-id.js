// Резолв spreadsheet-ID для модуля Подбор с поддержкой TEST_MODE.
//
// Когда PODBOR_TEST_MODE=true → все READ/WRITE Подбора идут в
// PODBOR_TEST_SPREADSHEET_ID (тестовая таблица с копиями листов).
// Боевые UPSELLER / ПОДБОРЫ при этом не трогаются.
//
// Это даёт безопасную песочницу для отработки sync engine, не задевая прод.

let _bannerShown = false;

export function isTestMode() {
  return String(process.env.PODBOR_TEST_MODE || '').toLowerCase() === 'true';
}

function ensureBanner() {
  if (_bannerShown) return;
  _bannerShown = true;
  if (isTestMode()) {
    const id = process.env.PODBOR_TEST_SPREADSHEET_ID;
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  [PODBOR] TEST MODE ON');
    console.log('  Все чтения/записи Подбора идут в тестовую таблицу:');
    console.log('  ' + id);
    console.log('  Боевые UPSELLER / ПОДБОРЫ не затрагиваются.');
    console.log('═══════════════════════════════════════════════════════════');
  } else {
    console.log('[PODBOR] PROD MODE — операции пишут в боевые таблицы.');
  }
}

// ID листа с КОРОБЫ. В тесте — единая таблица, в проде — UPSELLER.
export function getKorobySpreadsheetId() {
  ensureBanner();
  if (isTestMode()) {
    const id = process.env.PODBOR_TEST_SPREADSHEET_ID;
    if (!id) throw new Error('PODBOR_TEST_MODE=true, но PODBOR_TEST_SPREADSHEET_ID не задан');
    return id;
  }
  const id = process.env.UPSELLER_ID;
  if (!id) throw new Error('UPSELLER_ID не задан в .env');
  return id;
}

// ID листа с БД_ЭКСП / ВР / БД. В тесте — та же таблица, в проде — ПОДБОРЫ.
export function getPodborySpreadsheetId() {
  ensureBanner();
  if (isTestMode()) {
    const id = process.env.PODBOR_TEST_SPREADSHEET_ID;
    if (!id) throw new Error('PODBOR_TEST_MODE=true, но PODBOR_TEST_SPREADSHEET_ID не задан');
    return id;
  }
  const id = process.env.PODBORY_ID;
  if (!id) throw new Error('PODBORY_ID не задан в .env');
  return id;
}

// ID таблицы НАЧИСЛЕНИЯ (отдельная от ПОДБОРЫ). Лист `НАЧ` — зарплатный
// append-only журнал. В тесте — единая тестовая таблица. В проде — таблица
// `1tbUsKXEZK_...`, расшарена на тот же сервис-аккаунт.
// До 2026-05-14 nach-writer ошибочно использовал PODBORY_ID → начисления
// попадали в чужую таблицу. Фикс: отдельная переменная NACHISLENIYA_ID.
export function getNachislenyaSpreadsheetId() {
  ensureBanner();
  if (isTestMode()) {
    const id = process.env.PODBOR_TEST_SPREADSHEET_ID;
    if (!id) throw new Error('PODBOR_TEST_MODE=true, но PODBOR_TEST_SPREADSHEET_ID не задан');
    return id;
  }
  const id = process.env.NACHISLENIYA_ID;
  if (!id) throw new Error('NACHISLENIYA_ID не задан в .env (нужен для записи начислений в лист НАЧ)');
  return id;
}
