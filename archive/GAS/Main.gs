const APP_VERSION = 'v24';
const APP_RELEASE_NOTES = [
  'Исправлена причина разъезжания верхней панели во время загрузки: стабилизирован layout тулбара.',
  'Возвращены этапы загрузки со статусами и желтой точкой на время процесса.',
  'Зеленая точка снова означает только устойчивое подключение к таблице.',
  'Сборка подготовлена как финальная на сегодня перед передачей в тестирование.',
].join('\n');

const APP_CONFIG = {
  spreadsheetId: '1yORm5SHJlBXrJx2JwutCJXKLQjqqFozVxZqV0hu4a8Q',
  sourceSheetName: 'ОТГ_FILT',
  sourceStartRow: 2,
  sourceHeaderRange: buildA1Range_('ОТГ_FILT', 'A1:BK1'),
  sourceDataRange: buildA1Range_('ОТГ_FILT', 'A2:BK'),
  sourceWriteMapRange: buildA1Range_('ОТГ_FILT', 'BL2:BM'),
  sourceLastDataColumn: columnLetterToNumber_('BK'),
  writeSheetName: '🚚 ОТГ',
  writeStartRow: 13,
  writeLookupRange: buildA1Range_('🚚 ОТГ', 'L13:L'),
  validationSampleRows: 100,
  lastDataColumn: columnLetterToNumber_('BD'),
  dateColumn: columnLetterToNumber_('AH'),
  statusColumn: columnLetterToNumber_('BC'),
  shipmentKeyColumn: columnLetterToNumber_('L'),
  timezone: 'Europe/Moscow',
};

const FIELD_DEFINITIONS = [
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

const FIELD_MAP = FIELD_DEFINITIONS.reduce(function(map, field) {
  map[field.key] = field;
  return map;
}, {});

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Календарь отгрузок')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getAppBootstrap() {
  const today = new Date();
  const defaultDate = Utilities.formatDate(today, APP_CONFIG.timezone, 'yyyy-MM-dd');

  return {
    version: APP_VERSION,
    releaseNotes: APP_RELEASE_NOTES,
    defaultDate: defaultDate,
    fields: FIELD_DEFINITIONS,
    statusOptions: getValidationOptions_('BC'),
    qualityControlOptions: getValidationOptions_('U'),
    dataTransferredOptions: getValidationOptions_('V'),
    barcodeAppliedOptions: getValidationOptions_('W'),
    spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/' + APP_CONFIG.spreadsheetId + '/edit',
  };
}

function getCalendarData(startDateString, includeShipped) {
  const startDate = parseInputDate_(startDateString);
  const sourceTable = readShipmentTable_();
  const rows = sourceTable.rows;
  const groupedRows = rows.reduce(function(map, row) {
    if (!row.shipDate || !row.shipmentKey) {
      return map;
    }
    if (!map[row.shipDate]) {
      map[row.shipDate] = [];
    }
    map[row.shipDate].push(row);
    return map;
  }, {});

  const days = Object.keys(groupedRows)
    .sort()
    .map(function(isoDate) {
      return {
        isoDate: isoDate,
        displayDate: formatIsoDate_(isoDate),
        title: isoDate === Utilities.formatDate(startDate, APP_CONFIG.timezone, 'yyyy-MM-dd')
          ? 'Выбранная дата'
          : formatIsoDate_(isoDate),
        count: groupedRows[isoDate].length,
        rows: groupedRows[isoDate],
      };
    });

  return {
    requestedDate: Utilities.formatDate(startDate, APP_CONFIG.timezone, 'yyyy-MM-dd'),
    includeShipped: Boolean(includeShipped),
    headers: sourceTable.headers,
    days: days,
    fetchedAt: Utilities.formatDate(new Date(), APP_CONFIG.timezone, 'dd.MM.yyyy HH:mm:ss'),
  };
}

function updateShipmentRow(rowNumber, changes, shipmentKey) {
  if (typeof changes !== 'object' || !Object.keys(changes).length) {
    throw new Error('Не переданы изменения для сохранения.');
  }

  const actualRowNumber = resolveCurrentWriteRowNumber_(shipmentKey, rowNumber);
  if (!actualRowNumber) {
    throw new Error('Не удалось определить актуальную строку для сохранения.');
  }

  const sheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId).getSheetByName(APP_CONFIG.writeSheetName);
  if (!sheet) {
    throw new Error('Не найден лист ' + APP_CONFIG.writeSheetName + '.');
  }

  Object.keys(changes).forEach(function(fieldKey) {
    const field = FIELD_MAP[fieldKey];
    if (!field || !field.editable) {
      throw new Error('Поле ' + fieldKey + ' не поддерживает запись.');
    }

    const columnNumber = columnLetterToNumber_(field.sourceColumn);
    const normalizedValue = normalizeForWrite_(changes[fieldKey]);
    sheet.getRange(Number(actualRowNumber), columnNumber).setValue(normalizedValue);
  });

  SpreadsheetApp.flush();

  return {
    rowNumber: Number(actualRowNumber),
    updatedFields: Object.keys(changes),
    savedAt: Utilities.formatDate(new Date(), APP_CONFIG.timezone, 'dd.MM.yyyy HH:mm:ss'),
  };
}

function readShipmentTable_() {
  const sourceTable = fetchSourceTableViaApi_();
  const writeRowByShipmentKey = buildSourceWriteRowLookupByShipmentKey_();

  return {
    headers: sourceTable.headers,
    rows: sourceTable.rows.map(function(rawRow, index) {
      const shipmentKey = cleanString_(rawRow[APP_CONFIG.shipmentKeyColumn - 1]);
      const shipDate = normalizeSheetDate_(rawRow[APP_CONFIG.dateColumn - 1]);
      const record = {
        rowNumber: writeRowByShipmentKey[shipmentKey] || 0,
        sourceRowNumber: APP_CONFIG.sourceStartRow + index,
        shipDate: shipDate,
        shipmentKey: shipmentKey,
        status: cleanString_(rawRow[APP_CONFIG.statusColumn - 1]),
        balanceNumeric: normalizeNumber_(rawRow[columnLetterToNumber_('H') - 1]),
        shipmentCostNumeric: normalizeNumber_(rawRow[columnLetterToNumber_('AR') - 1]),
      };

      FIELD_DEFINITIONS.forEach(function(field) {
        const columnIndex = columnLetterToNumber_(field.sourceColumn) - 1;
        record[field.key] = formatFieldDisplayValue_(field, rawRow[columnIndex]);
      });

      return record;
    }),
  };
}

function fetchSourceTableViaApi_() {
  const valueRanges = batchGetSheetValues_([
    APP_CONFIG.sourceHeaderRange,
    APP_CONFIG.sourceDataRange,
  ]);

  const headers = getValueRangeRows_(valueRanges, 0)[0] || [];
  const rows = filterRowsByShipmentKey_(trimTrailingEmptyRows_(getValueRangeRows_(valueRanges, 1)));

  return {
    headers: headers,
    rows: rows,
  };
}

function buildSourceWriteRowLookupByShipmentKey_() {
  const valueRanges = batchGetSheetValues_([APP_CONFIG.sourceWriteMapRange]);
  const rows = getValueRangeRows_(valueRanges, 0);
  const lookup = {};

  rows.forEach(function(row, index) {
    const shipmentKey = cleanString_(row[1]);
    const rowNumber = normalizeNumber_(row[0]);
    if (!shipmentKey || lookup[shipmentKey]) {
      return;
    }
    lookup[shipmentKey] = rowNumber || 0;
  });

  return lookup;
}

function buildWriteRowLookupByShipmentKey_() {
  const valueRanges = batchGetSheetValues_([APP_CONFIG.writeLookupRange]);
  const rows = getValueRangeRows_(valueRanges, 0);
  const lookup = {};

  rows.forEach(function(row, index) {
    const shipmentKey = cleanString_(row[0]);
    if (!shipmentKey || lookup[shipmentKey]) {
      return;
    }
    lookup[shipmentKey] = APP_CONFIG.writeStartRow + index;
  });

  return lookup;
}

function resolveCurrentWriteRowNumber_(shipmentKey, fallbackRowNumber) {
  const key = cleanString_(shipmentKey);
  if (!key) {
    return Number(fallbackRowNumber) || 0;
  }

  const helperRowNumber = resolveWriteRowFromSourceHelper_(key);
  if (helperRowNumber) {
    return helperRowNumber;
  }

  const liveLookup = buildWriteRowLookupByShipmentKey_();
  if (liveLookup[key]) {
    return liveLookup[key];
  }

  return Number(fallbackRowNumber) || 0;
}

function resolveWriteRowFromSourceHelper_(shipmentKey) {
  const valueRanges = batchGetSheetValues_([APP_CONFIG.sourceWriteMapRange]);
  const rows = getValueRangeRows_(valueRanges, 0);

  for (var index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const helperRowNumber = normalizeNumber_(row[0]);
    const helperShipmentKey = cleanString_(row[1]);

    if (!helperRowNumber || !helperShipmentKey) {
      continue;
    }

    if (helperShipmentKey === shipmentKey) {
      return helperRowNumber;
    }
  }

  return 0;
}

function batchGetSheetValues_(ranges) {
  const query = [
    'majorDimension=ROWS',
    'valueRenderOption=UNFORMATTED_VALUE',
    'dateTimeRenderOption=SERIAL_NUMBER',
  ].concat(ranges.map(function(range) {
    return 'ranges=' + encodeURIComponent(range);
  })).join('&');

  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' +
    encodeURIComponent(APP_CONFIG.spreadsheetId) +
    '/values:batchGet?' +
    query;

  const response = UrlFetchApp.fetch(url, {
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
    },
    muteHttpExceptions: true,
  });

  const statusCode = response.getResponseCode();
  if (statusCode >= 400) {
    throw new Error('Sheets API batchGet завершился ошибкой ' + statusCode + ': ' + response.getContentText());
  }

  const payload = JSON.parse(response.getContentText() || '{}');
  return payload.valueRanges || [];
}

function getValueRangeRows_(valueRanges, index) {
  const valueRange = valueRanges[index];
  return valueRange && valueRange.values ? valueRange.values : [];
}

function trimTrailingEmptyRows_(rows) {
  const trimmed = rows.slice();
  while (trimmed.length && isEmptyRow_(trimmed[trimmed.length - 1])) {
    trimmed.pop();
  }
  return trimmed;
}

function filterRowsByShipmentKey_(rows) {
  return rows.filter(function(row) {
    return cleanString_(row[APP_CONFIG.shipmentKeyColumn - 1]) !== '';
  });
}

function isEmptyRow_(row) {
  return !row || !row.some(function(cell) {
    return cleanString_(cell) !== '';
  });
}

function formatFieldDisplayValue_(field, rawValue) {
  if (field.key === 'balance' || field.key === 'shipmentCost') {
    return formatRubles_(rawValue);
  }
  return cleanString_(rawValue);
}

function formatRubles_(value) {
  const numericValue = normalizeNumber_(value);
  if (!numericValue) {
    return '0';
  }

  const absolute = Math.abs(Math.trunc(numericValue)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (numericValue < 0 ? '-' : '') + absolute + 'р.';
}

function buildA1Range_(sheetName, a1Range) {
  return '\'' + String(sheetName).replace(/'/g, '\'\'') + '\'!' + a1Range;
}

function formatIsoDate_(isoDate) {
  var match = String(isoDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return cleanString_(isoDate);
  }
  return [match[3], match[2], match[1]].join('.');
}

function normalizeSheetDate_(rawValue) {
  if (rawValue instanceof Date && !isNaN(rawValue.getTime())) {
    return Utilities.formatDate(rawValue, APP_CONFIG.timezone, 'yyyy-MM-dd');
  }

  if (typeof rawValue === 'number') {
    const serialDate = serialNumberToDate_(rawValue);
    if (!isNaN(serialDate.getTime())) {
      return Utilities.formatDate(serialDate, APP_CONFIG.timezone, 'yyyy-MM-dd');
    }
  }

  const text = cleanString_(rawValue);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  const match = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (match) {
    return [match[3], match[2], match[1]].join('-');
  }

  return '';
}

function serialNumberToDate_(serialNumber) {
  const milliseconds = Math.round((Number(serialNumber) - 25569) * 24 * 60 * 60 * 1000);
  return new Date(milliseconds);
}

function parseInputDate_(dateString) {
  const parts = String(dateString || '').split('-');
  if (parts.length !== 3) {
    throw new Error('Некорректная дата: ' + dateString);
  }

  return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

function addDays_(date, days) {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  copy.setDate(copy.getDate() + days);
  return copy;
}

function normalizeForWrite_(value) {
  const normalized = String(value == null ? '' : value).trim();
  return normalized;
}

function getValidationOptions_(columnLetter) {
  const sheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId).getSheetByName(APP_CONFIG.writeSheetName);
  if (!sheet) {
    return [];
  }

  const column = columnLetterToNumber_(columnLetter);
  const lastRow = Math.max(sheet.getLastRow(), APP_CONFIG.writeStartRow + 10);
  const sampleRows = Math.min(lastRow - APP_CONFIG.writeStartRow + 1, APP_CONFIG.validationSampleRows);
  const validations = sheet.getRange(APP_CONFIG.writeStartRow, column, sampleRows, 1).getDataValidations();

  for (var row = 0; row < validations.length; row += 1) {
    const rule = validations[row][0];
    if (!rule) {
      continue;
    }

    const criteriaType = rule.getCriteriaType();
    const criteriaValues = rule.getCriteriaValues();
    if (criteriaType === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST && criteriaValues && criteriaValues[0]) {
      return criteriaValues[0].slice();
    }
  }

  return [];
}

function normalizeNumber_(value) {
  if (typeof value === 'number') {
    return value;
  }

  const text = cleanString_(value).replace(/\s+/g, '').replace(',', '.').replace(/[^\d.-]/g, '');
  if (!text) {
    return 0;
  }

  const parsed = Number(text);
  return isNaN(parsed) ? 0 : parsed;
}

function cleanString_(value) {
  return String(value == null ? '' : value).replace(/\u2060/g, '').trim();
}

function columnLetterToNumber_(columnLetter) {
  return String(columnLetter).split('').reduce(function(total, character) {
    return total * 26 + (character.toUpperCase().charCodeAt(0) - 64);
  }, 0);
}
