// Валидация обязательных ENV-переменных при старте сервера.
//
// Цель: ловить забытые переменные при `npm start`, а не через несколько часов
// на пользователе (как было 2026-05-15 с забытым NACHISLENIYA_ID).
// При недостающих ENV — печатаем понятный список и process.exit(1).
// pm2 автоматически рестартует и быстро попадёт в backoff → видно в первую минуту.

const ALWAYS_REQUIRED = [
  { name: 'SESSION_SECRET', minLen: 32, hint: 'JWT signing key — `openssl rand -hex 32`' },
  { name: 'UPSELLER_ID', hint: 'ID боевой таблицы UPSELLER (лист 🍬 КОРОБЫ)' },
  { name: 'PODBORY_ID', hint: 'ID таблицы ПОДБОРЫ АПСЕЛЛЕР (лист БД, ВР, ⏩ЗАЯВКА)' },
  { name: 'NACHISLENIYA_ID', hint: 'ID таблицы НАЧИСЛЕНИЯ (лист НАЧ, append-only журнал зарплат)' },
  { name: 'INVENT_SPREADSHEET_ID', hint: 'ID легаси-таблицы Инвента' },
];

const PROD_REQUIRED = [
  { name: 'GOOGLE_WEB_CLIENT_ID', hint: 'OAuth client ID для popup-логина пользователей (нужен на проде, не на dev)' },
  { name: 'ADMIN_EMAIL', hint: 'Bootstrap админ whitelist (первый super-user)' },
];

// Хотя бы одна из пары должна быть задана.
const EITHER_OR = [
  {
    names: ['GOOGLE_SERVICE_ACCOUNT_KEY_PATH', 'GOOGLE_SERVICE_ACCOUNT_KEY'],
    hint: 'Путь к JSON-ключу сервис-аккаунта ИЛИ сам JSON одной строкой',
  },
];

export function validateEnv() {
  const missing = [];
  const tooShort = [];
  const isProd = String(process.env.AUTH_DISABLED || '').toLowerCase() !== 'true';

  for (const { name, minLen, hint } of ALWAYS_REQUIRED) {
    const v = process.env[name];
    if (!v || !v.trim()) {
      missing.push({ name, hint });
    } else if (minLen && v.trim().length < minLen) {
      tooShort.push({ name, hint, actual: v.trim().length, required: minLen });
    }
  }

  if (isProd) {
    for (const { name, hint } of PROD_REQUIRED) {
      const v = process.env[name];
      if (!v || !v.trim()) missing.push({ name, hint, prodOnly: true });
    }
  }

  for (const { names, hint } of EITHER_OR) {
    const ok = names.some(n => process.env[n] && process.env[n].trim());
    if (!ok) missing.push({ name: names.join(' OR '), hint });
  }

  if (missing.length === 0 && tooShort.length === 0) {
    console.log(`[env-validator] OK (${isProd ? 'PROD' : 'DEV'} mode, all required vars present)`);
    return;
  }

  console.error('═══════════════════════════════════════════════════════════');
  console.error('[env-validator] FAIL — обязательные ENV отсутствуют или некорректны:');
  console.error('═══════════════════════════════════════════════════════════');
  for (const m of missing) {
    const tag = m.prodOnly ? ' [PROD]' : '';
    console.error(`  ✗ ${m.name}${tag}`);
    console.error(`      └ ${m.hint}`);
  }
  for (const m of tooShort) {
    console.error(`  ✗ ${m.name} — длина ${m.actual} символов, требуется минимум ${m.required}`);
    console.error(`      └ ${m.hint}`);
  }
  console.error('═══════════════════════════════════════════════════════════');
  console.error('Сервер не стартует. Дополни /opt/upseller/.env (или server/.env локально) и рестартни.');
  console.error('═══════════════════════════════════════════════════════════');
  process.exit(1);
}
