const today = new Date().toISOString().slice(0, 10);

export const FORM_OPTIONS = {
  receivers: ['Акобян Нуня', 'Хачатрян Тигран', 'Артем', 'Карина'],
  operators: ['Артем', 'Карина', 'Local Dev'],
  productTypes: ['Товар', 'Микс', 'Хрупкое', 'КГТ', 'Проверка'],
  tareOwners: ['КЛ', 'ФФ'],
  shifts: ['1', '2', 'Ночь'],
};

export const SUPPLIES = [
  {
    id: 'P4796',
    code: 'P4796',
    label: 'P4796 - ГалаОпт',
    client: 'ГалаОпт',
    status: 'В приемке',
    date: today,
    form: {
      date: today,
      receiver: 'Акобян Нуня',
      operator: 'Артем',
      shift: '1',
      productType: 'Товар',
      tareOwner: 'КЛ',
      pallets: 2,
      extraCharge: '',
      comment: 'Поставка из GAS v0.6, демо-состав для web-планшета',
    },
    items: [
      { id: 'i1', sku: 'Зеркало с подсветкой', barcode: '2048816725968', plan: 480, dims: { w: 18, d: 25, h: 4 }, weight: 360, shelfLife: '' },
      { id: 'i2', sku: 'Массажер для ног LL-Z06', barcode: '2046279410520', plan: 672, dims: { w: 15, d: 19, h: 33 }, weight: 1215, shelfLife: '' },
      { id: 'i3', sku: 'Массажная накидка с подогревом', barcode: '2047883869667', plan: 280, dims: { w: 31, d: 11, h: 49 }, weight: 1100, shelfLife: '' },
      { id: 'i4', sku: 'Щетка для мойки посуды Magic Brush', barcode: '2046938117265', plan: 576, dims: { w: 18, d: 23, h: 8 }, weight: 280, shelfLife: '' },
      { id: 'i5', sku: 'Весы для младенцев', barcode: '2046279417475', plan: 500, dims: { w: 33, d: 4, h: 56 }, weight: 1550, shelfLife: '' },
      { id: 'i6', sku: 'Надувной матрас в машину', barcode: '2046733052976', plan: 10, dims: { w: 30, d: 27, h: 12 }, weight: 1880, shelfLife: '' },
      { id: 'i7', sku: 'Аэрогриль черный 6 л.', barcode: '2047000348549', plan: 4, dims: { w: 36, d: 32, h: 37 }, weight: 5000, shelfLife: '' },
      { id: 'i8', sku: 'Вафельница электрическая', barcode: '2049110508646', plan: 800, dims: { w: 2, d: 3, h: 1 }, weight: 15, shelfLife: '' },
      { id: 'i9', sku: 'Мини стиральная машинка', barcode: '2048107554024', plan: 72, dims: { w: 30, d: 15, h: 30 }, weight: 1423, shelfLife: '' },
      { id: 'i10', sku: 'Велотренажер', barcode: '2048642973328', plan: 40, dims: { w: 16, d: 46, h: 9 }, weight: 1900, shelfLife: '' },
    ],
  },
  {
    id: 'P4821',
    code: 'P4821',
    label: 'P4821 - ТехноМаркет',
    client: 'ТехноМаркет',
    status: 'Ожидает',
    date: today,
    form: {
      date: today,
      receiver: '',
      operator: 'Карина',
      shift: '2',
      productType: 'Хрупкое',
      tareOwner: 'ФФ',
      pallets: 1,
      extraCharge: 'Проверка стекла',
      comment: '',
    },
    items: [
      { id: 'p4821-1', sku: 'Лампа настольная LED', barcode: '2030000001001', plan: 120, dims: { w: 14, d: 14, h: 28 }, weight: 620, shelfLife: '' },
      { id: 'p4821-2', sku: 'Чайник электрический 1.7 л', barcode: '2030000001002', plan: 96, dims: { w: 22, d: 18, h: 24 }, weight: 980, shelfLife: '' },
      { id: 'p4821-3', sku: 'Органайзер кухонный', barcode: '2030000001003', plan: 240, dims: { w: 30, d: 12, h: 8 }, weight: 310, shelfLife: '' },
    ],
  },
  {
    id: 'P4850',
    code: 'P4850',
    label: 'P4850 - ДомКомфорт',
    client: 'ДомКомфорт',
    status: 'Новая',
    date: today,
    form: {
      date: today,
      receiver: 'Хачатрян Тигран',
      operator: 'Артем',
      shift: '1',
      productType: 'КГТ',
      tareOwner: 'КЛ',
      pallets: 4,
      extraCharge: '',
      comment: 'Крупный товар, принимать в отдельные короба',
    },
    items: [
      { id: 'p4850-1', sku: 'Стеллаж складной', barcode: '2030000002001', plan: 36, dims: { w: 90, d: 35, h: 12 }, weight: 7200, shelfLife: '' },
      { id: 'p4850-2', sku: 'Кресло офисное', barcode: '2030000002002', plan: 24, dims: { w: 62, d: 58, h: 48 }, weight: 11200, shelfLife: '' },
    ],
  },
];

export function listSupplyOptions() {
  return SUPPLIES.map(({ id, code, label, client, date, status, items }) => ({
    id,
    code,
    label,
    client,
    date,
    status,
    skuCount: items.length,
    unitsTotal: items.reduce((sum, item) => sum + Number(item.plan || 0), 0),
  }));
}

export function getSupplyBootstrap(supplyId) {
  const supply = SUPPLIES.find((item) => item.id === supplyId || item.code === supplyId) || SUPPLIES[0];
  return {
    context: {
      source: 'mock-gas-v06',
      spreadsheetId: process.env.RECEIVING_SPREADSHEET_ID || '1wlz94rEXUEwkRLshk3l6YWXqMBBTSuClTWRU-Zbuvx8',
      sheetName: process.env.RECEIVING_SHEET_NAME || 'ПР',
    },
    meta: {
      loadedAt: new Date().toISOString(),
      version: 'receiving-web-mock-v1',
    },
    supply: {
      id: supply.id,
      code: supply.code,
      label: supply.label,
      client: supply.client,
      date: supply.date,
      status: supply.status,
      ...supply.form,
    },
    form: { ...supply.form },
    formOptions: FORM_OPTIONS,
    items: supply.items.map((item) => ({ ...item, dims: { ...item.dims } })),
    clientCatalog: supply.items.map((item) => ({
      sku: item.sku,
      barcode: item.barcode,
      dims: { ...item.dims },
      weight: item.weight,
    })),
    defaults: {
      boxDims: { w: 60, d: 40, h: 40 },
      initialBoxCount: 9,
    },
    supplyOptions: listSupplyOptions(),
  };
}
