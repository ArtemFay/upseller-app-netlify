export const APP_VERSION = 'web-v1.0';

export const APP_RELEASE_NOTES = [
  'Первая веб-версия Календаря отгрузок в Upseller.',
  'Запись идёт напрямую в Google-таблицу через API.',
  'UI и логика перенесены из исходного Apps Script.',
].join('\n');

export const APP_CONFIG = {
  sourceSheetName: 'ОТГ_FILT',
  sourceStartRow: 2,
  sourceHeaderRange: "'ОТГ_FILT'!A1:BK1",
  sourceDataRange: "'ОТГ_FILT'!A2:BK",
  sourceWriteMapRange: "'ОТГ_FILT'!BL2:BM",
  writeSheetName: '🚚 ОТГ',
  writeStartRow: 13,
  writeLookupRange: "'🚚 ОТГ'!L13:L",
  validationSampleRows: 100,
  timezone: 'Europe/Moscow',
};

export const FIELD_DEFINITIONS = [
  { key: 'balance', label: 'Баланс', sourceColumn: 'H', editable: false, width: '74px', align: 'right', visible: true },
  { key: 'shipmentCost', label: 'Стоим.\nотгруз', sourceColumn: 'AR', editable: false, width: '68px', align: 'right', visible: true },
  { key: 'rate', label: 'Рейт', sourceColumn: 'I', editable: false, width: '48px', align: 'center', visible: true },
  { key: 'shipmentType', label: 'Тип\nотг', sourceColumn: 'J', editable: false, width: '48px', align: 'center', visible: true },
  { key: 'tareType', label: 'Тип\nтары', sourceColumn: 'K', editable: false, width: '52px', align: 'center', visible: true },
  { key: 'shipmentId', label: 'Отгрузка', sourceColumn: 'F', editable: false, width: '170px', align: 'left', visible: true },
  { key: 'volume', label: 'Кол\nкор', sourceColumn: 'Q', editable: true, width: '58px', align: 'right', visible: true },
  { key: 'marketplace', label: 'МП', sourceColumn: 'Z', editable: false, width: '48px', align: 'center', visible: true },
  { key: 'carrier', label: 'Кто\nвез', sourceColumn: 'AB', editable: false, width: '56px', align: 'center', visible: true },
  { key: 'destinationWarehouse', label: 'Склад\nназнач', sourceColumn: 'AC', editable: false, width: '142px', align: 'left', visible: true },
  { key: 'finalWarehouse', label: 'Кон\nсклад', sourceColumn: 'AD', editable: false, width: '142px', align: 'left', visible: true },
  { key: 'timeSlot', label: 'Тайм\nслот', sourceColumn: 'AE', editable: true, width: '78px', align: 'center', visible: false },
  { key: 'status', label: 'Статус', sourceColumn: 'BC', editable: true, width: '104px', align: 'center', visible: true },
  { key: 'driver', label: 'Водитель', sourceColumn: 'AN', editable: true, width: '142px', align: 'left', visible: true },
  { key: 'vehicle', label: 'Авто', sourceColumn: 'AM', editable: true, width: '142px', align: 'left', visible: true },
  { key: 'qualityControl', label: 'ОТК', sourceColumn: 'U', editable: true, width: '64px', align: 'center', visible: true },
  { key: 'dataTransferred', label: 'Данн\nперед', sourceColumn: 'V', editable: true, width: '76px', align: 'center', visible: true },
  { key: 'barcodeApplied', label: 'ШК\nпрокл', sourceColumn: 'W', editable: true, width: '76px', align: 'center', visible: true },
  { key: 'comment', label: 'Коммент', sourceColumn: 'BD', editable: true, width: '284px', align: 'left', visible: true },
];

export const FIELD_MAP = FIELD_DEFINITIONS.reduce((map, field) => {
  map[field.key] = field;
  return map;
}, {});

APP_CONFIG.shipmentKeyColumn = columnLetterToNumber('L');
APP_CONFIG.dateColumn = columnLetterToNumber('AH');
APP_CONFIG.statusColumn = columnLetterToNumber('BC');

export function columnLetterToNumber(letters) {
  return String(letters).split('').reduce((total, c) => total * 26 + (c.toUpperCase().charCodeAt(0) - 64), 0);
}

export function cleanString(value) {
  return String(value == null ? '' : value).replace(/\u2060/g, '').trim();
}

export function normalizeNumber(value) {
  if (typeof value === 'number') return value;
  const text = cleanString(value).replace(/\s+/g, '').replace(',', '.').replace(/[^\d.-]/g, '');
  if (!text) return 0;
  const parsed = Number(text);
  return isNaN(parsed) ? 0 : parsed;
}

export function formatRubles(value) {
  const n = normalizeNumber(value);
  if (!n) return '0';
  const absolute = Math.abs(Math.trunc(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (n < 0 ? '-' : '') + absolute + 'р.';
}

export function formatFieldDisplayValue(field, rawValue) {
  if (field.key === 'balance' || field.key === 'shipmentCost') return formatRubles(rawValue);
  return cleanString(rawValue);
}

function getMoscowParts(date) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_CONFIG.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return parts;
}

export function formatDateMoscow(date) {
  const p = getMoscowParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

export function formatDateTimeMoscow(date) {
  const p = getMoscowParts(date);
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

export function formatIsoDate(isoDate) {
  const m = String(isoDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return cleanString(isoDate);
  return [m[3], m[2], m[1]].join('.');
}

export function serialNumberToDate(serial) {
  const ms = Math.round((Number(serial) - 25569) * 86400 * 1000);
  return new Date(ms);
}

export function normalizeSheetDate(rawValue) {
  if (rawValue instanceof Date && !isNaN(rawValue.getTime())) {
    return formatDateMoscow(rawValue);
  }
  if (typeof rawValue === 'number') {
    const d = serialNumberToDate(rawValue);
    if (!isNaN(d.getTime())) return formatDateMoscow(d);
  }
  const text = cleanString(rawValue);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const m = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m) return [m[3], m[2], m[1]].join('-');
  return '';
}

export function trimTrailingEmptyRows(rows) {
  const result = [...rows];
  while (result.length && isEmptyRow(result[result.length - 1])) result.pop();
  return result;
}

export function isEmptyRow(row) {
  return !row || !row.some(c => cleanString(c) !== '');
}
