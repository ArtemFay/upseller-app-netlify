const DEFAULT_DIMS = { w: 60, d: 40, h: 40 };

const state = {
  mode: localStorage.getItem("receiving.mode") || guessMode(),
  tab: "scan",
  loading: true,
  loadingSupplies: false,
  countsToken: 0,
  loadError: "",
  supplySelected: false,
  supplyOptions: [],
  formOptions: {
    receivers: [],
    operators: [],
    productTypes: [],
    tareOwners: ["КЛ", "ФФ"],
    shifts: ["1", "2", "Ночь"]
  },
  search: "",
  activeBoxCode: "",
  scanBuffer: "",
  lastMessage: "Выберите поставку для начала приемки.",
  supply: {
    id: "",
    code: "",
    client: "",
    date: "",
    shift: "",
    operator: "",
    receiver: "",
    productType: "",
    tareOwner: "",
    pallets: "",
    extraCharge: "",
    comment: "",
    status: ""
  },
  items: [],
  boxes: [],
  events: [],
  errors: []
};

const root = document.getElementById("root");
const app = document.getElementById("app");
const $ = (selector) => document.querySelector(selector);

async function apiJson(url) {
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      message = body.error || message;
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

async function loadSupplyOptions() {
  state.loading = true;
  state.loadingSupplies = true;
  state.loadError = "";
  state.lastMessage = "Загружаем активные поставки...";
  render();
  try {
    const data = await apiJson("/api/receiving/supplies");
    state.supplyOptions = data.supplies || [];
    state.supplySelected = false;
    state.supply = {
      id: "",
      code: "",
      client: "",
      date: "",
      shift: "",
      operator: "",
      receiver: "",
      productType: "",
      tareOwner: "",
      pallets: "",
      extraCharge: "",
      comment: "",
      status: ""
    };
    state.items = [];
    state.boxes = [];
    state.activeBoxCode = "";
    state.events = [];
    state.errors = [];
    state.lastMessage = "Выберите поставку для начала приемки.";
    enrichSupplyCounts();
  } catch (error) {
    state.loadError = error.message || String(error);
    state.lastMessage = `Не удалось загрузить список поставок: ${state.loadError}`;
  } finally {
    state.loading = false;
    state.loadingSupplies = false;
    render();
  }
}

async function loadBootstrap(supplyCode) {
  state.countsToken += 1;
  state.loading = true;
  state.loadingSupplies = false;
  state.loadError = "";
  state.lastMessage = "Загружаем содержимое выбранной поставки...";
  render();
  try {
    const qs = supplyCode ? `?supply=${encodeURIComponent(supplyCode)}` : "";
    const data = await apiJson(`/api/receiving/bootstrap${qs}`);
    applyBootstrap(data);
  } catch (error) {
    state.loadError = error.message || String(error);
    state.lastMessage = `Не удалось загрузить поставки: ${state.loadError}`;
  } finally {
    state.loading = false;
    render();
  }
}

async function enrichSupplyCounts() {
  const token = ++state.countsToken;
  const options = state.supplyOptions.slice();
  for (const option of options) {
    if (token !== state.countsToken || state.supplySelected) return;
    try {
      const label = option.label || option.code || option.id;
      const data = await apiJson(`/api/receiving/bootstrap?supply=${encodeURIComponent(label)}`);
      if (token !== state.countsToken || state.supplySelected) return;
      const unitsTotal = (data.items || []).reduce((sum, item) => sum + Number(item.plan || 0), 0);
      const code = data.supply?.code || option.code;
      state.supplyOptions = state.supplyOptions.map((item) => (
        (item.code || item.id) === code
          ? { ...item, skuCount: (data.items || []).length, unitsTotal, countsLoaded: true }
          : item
      ));
      render();
    } catch {
      // Счетчики в списке не должны блокировать выбор поставки.
    }
  }
}

function applyBootstrap(data) {
  const supply = data.supply || {};
  state.supplyOptions = data.supplyOptions || [];
  state.formOptions = { ...state.formOptions, ...(data.formOptions || {}) };
  state.supply = {
    ...state.supply,
    ...supply,
    ...(data.form || {}),
    id: supply.id || supply.code || state.supply.id,
    code: supply.code || state.supply.code,
    client: supply.client || state.supply.client,
    status: supply.status || state.supply.status
  };
  state.supplySelected = Boolean(state.supply.code);
  state.items = (data.items || []).map((item, index) => ({
    id: item.id || `item-${index}`,
    sku: item.sku || "",
    barcode: String(item.barcode || ""),
    plan: Number(item.plan || 0),
    dims: item.dims || { w: 0, d: 0, h: 0 },
    weight: Number(item.weight || 0),
    shelfLife: item.shelfLife || ""
  }));
  state.boxes = [];
  state.activeBoxCode = "";
  state.events = [];
  state.errors = [];
  createBoxes((data.defaults && data.defaults.initialBoxCount) || 9);
  state.lastMessage = `Поставка ${state.supply.code} загружена. Сначала отсканируйте короб.`;
  logEvent("supply_loaded", `Загружена поставка ${state.supply.code}: ${state.items.length} SKU`);
}

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function objectValues(obj) {
  return Object.keys(obj || {}).map((key) => obj[key]);
}

function guessMode() {
  const w = window.innerWidth;
  if (w <= 420) return "tsd";
  if (w <= 700) return "phone";
  if (w <= 1200) return "tablet";
  return "desktop";
}

function pad3(n) {
  const raw = String(n);
  return raw.length >= 3 ? raw : new Array(4 - raw.length).join("0") + raw;
}

function sanitizeInt(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.round(n);
}

function tareCoeff(dims = DEFAULT_DIMS) {
  const w = sanitizeInt(dims.w, DEFAULT_DIMS.w);
  const d = sanitizeInt(dims.d, DEFAULT_DIMS.d);
  const h = sanitizeInt(dims.h, DEFAULT_DIMS.h);
  return Math.round(((w * d * h) / 96000 + Number.EPSILON) * 100) / 100;
}

function tareLabel(dims) {
  return `K_${tareCoeff(dims).toFixed(2).replace(".", ",")}`;
}

function createBoxes(count = 10) {
  if (!state.supplySelected || !state.supply.code) return;
  const start = state.boxes.reduce((max, box) => Math.max(max, box.index), 0) + 1;
  for (let i = 0; i < count; i += 1) {
    const index = start + i;
    state.boxes.push({
      id: `box-${state.supply.code}-${index}`,
      index,
      code: `${state.supply.code}-${pad3(index)}`,
      dims: { ...DEFAULT_DIMS },
      labelPrinted: true,
      status: "closed",
      items: {}
    });
  }
  logEvent("boxes_created", `Созданы короба: ${count}`);
}

function boxByCode(code) {
  return state.boxes.find((box) => box.code === code);
}

function itemByCode(raw) {
  const code = String(raw || "").trim();
  if (!code) return null;
  return state.items.find((item) => item.barcode === code || item.barcode.endsWith(code));
}

function factForItem(itemId) {
  return state.boxes.reduce((sum, box) => {
    const row = box.items[itemId];
    return sum + (row ? row.qty : 0);
  }, 0);
}

function boxQty(box) {
  return objectValues(box.items).reduce((sum, row) => sum + row.qty, 0);
}

function totalPlan() {
  return state.items.reduce((sum, item) => sum + item.plan, 0);
}

function totalFact() {
  return state.items.reduce((sum, item) => sum + factForItem(item.id), 0);
}

function addItemToBox(item, box, qty = 1, source = "scan") {
  if (!item) return fail("Товар не выбран", "item_required");
  if (!box) return fail("Короб не выбран", "scan_no_box");
  if (box.status !== "active") return fail(`Короб ${box.code} не открыт`, "scan_closed_box");

  const fact = factForItem(item.id);
  if (fact + qty > item.plan) {
    return fail(`Превышение плана по ${item.sku}`, "over_plan");
  }

  if (!box.items[item.id]) {
    box.items[item.id] = { itemId: item.id, sku: item.sku, barcode: item.barcode, qty: 0 };
  }
  box.items[item.id].qty += qty;
  box.status = "active";
  state.lastMessage = `${item.sku}: +${qty} в ${box.code}`;
  logEvent("item_added", `${item.barcode} +${qty} -> ${box.code}`, source);
  return true;
}

function fail(message, code) {
  state.lastMessage = message;
  state.errors.unshift({ id: uid("err"), code, message, at: nowTime() });
  logEvent("error", message, "system");
  return false;
}

function logEvent(type, text, source = "operator") {
  state.events.unshift({ id: uid("evt"), type, text, source, at: nowTime() });
  state.events = state.events.slice(0, 60);
}

function nowTime() {
  return new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function printLabels(targets) {
  const boxes = targets.length ? targets : state.boxes;
  boxes.forEach((box) => {
    box.labelPrinted = true;
    if (box.status === "created") box.status = "labeled";
  });
  logEvent("labels_printed", `Напечатаны этикетки: ${boxes.map((b) => b.code).join(", ")}`);
  openLabelWindow(boxes, "short");
}

function printComposition(box) {
  logEvent("composition_printed", `Печать состава: ${box.code}`);
  openLabelWindow([box], "full");
}

function openLabelWindow(boxes, kind) {
  const pages = boxes.map((box) => {
    const qr = `https://api.qrserver.com/v1/create-qr-code/?size=360x360&data=${encodeURIComponent(box.code)}`;
    const rows = objectValues(box.items)
      .map((row) => `<tr><td>${escapeHtml(row.sku)}</td><td>${row.barcode}</td><td>${row.qty}</td></tr>`)
      .join("");
    if (kind === "full") {
      return `<section class="label full"><div class="head"><div><h1>${box.code}</h1><p>${state.supply.client}</p><p>Состав короба</p></div><img src="${qr}"></div><table><thead><tr><th>SKU</th><th>Баркод</th><th>Кол</th></tr></thead><tbody>${rows || "<tr><td colspan='3'>Пусто</td></tr>"}</tbody></table></section>`;
    }
    return `<section class="label short"><h1>${box.code.replace("-", "<br>")}</h1><p>Поставка: ${state.supply.code}</p><p>Клиент: ${state.supply.client}</p><p>Тара: ${tareLabel(box.dims)}</p><img src="${qr}"></section>`;
  }).join("");
  const win = window.open("", "_blank", "width=900,height=700");
  if (!win) return;
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Этикетки</title><style>@page{size:100mm 150mm;margin:4mm}body{font-family:Arial;margin:0}.label{width:92mm;height:142mm;border:1mm solid #000;padding:4mm;page-break-after:always;box-sizing:border-box}.short{display:flex;flex-direction:column;justify-content:space-between}.short h1{font-size:18mm;line-height:.95;text-align:right;margin:0}.short p{font-size:6mm;font-weight:700;margin:1mm 0}.short img{width:56mm;height:56mm;align-self:center}.full h1{font-size:8mm;margin:0}.full p{font-size:4mm;margin:1mm 0}.full img{width:28mm;height:28mm}.head{display:flex;justify-content:space-between}.full table{width:100%;border-collapse:collapse;margin-top:3mm}.full th,.full td{border:.3mm solid #000;font-size:3.2mm;padding:1mm}</style></head><body>${pages}<script>window.onload=()=>window.print()<\/script></body></html>`);
  win.document.close();
}

function closeBox(box) {
  if (!box) return;
  box.status = "closed";
  if (state.activeBoxCode === box.code) state.activeBoxCode = "";
  state.lastMessage = `Короб ${box.code} закрыт`;
  logEvent("box_closed", `Закрыт короб ${box.code}`);
}

function openBox(box, source = "operator") {
  if (!box) return;
  const current = boxByCode(state.activeBoxCode);
  if (current && current.code !== box.code) {
    fail(`Сначала закройте активный короб ${current.code}`, "active_box_required_close");
    return;
  }
  if (current && current.code === box.code) {
    closeBox(current);
    return;
  }
  if (box.status === "closed" && boxQty(box) > 0) {
    fail(`Короб ${box.code} уже закрыт с содержимым`, "sealed_box");
    return;
  }
  box.status = "active";
  box.labelPrinted = true;
  state.activeBoxCode = box.code;
  state.lastMessage = `Активный короб ${box.code}`;
  logEvent("box_opened", `Открыт короб ${box.code}`, source);
}

function processScan(raw) {
  const code = String(raw || "").trim();
  if (!code) return;

  const box = boxByCode(code);
  if (box) {
    openBox(box, "scanner");
    return;
  }

  const item = itemByCode(code);
  if (!item) {
    fail(`Баркод не найден: ${code}`, "unknown_barcode");
    return;
  }
  addItemToBox(item, boxByCode(state.activeBoxCode), 1, "scanner");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[ch]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function statusText(box) {
  if (box.status === "closed") return "Закрыт";
  if (box.status === "active") return "Открыт";
  if (box.labelPrinted) return "Этикетка";
  return "Создан";
}

function statusClass(box) {
  if (box.status === "closed") return "gray";
  if (box.status === "active") return "";
  if (box.labelPrinted) return "warn";
  return "gray";
}

function render() {
  app.className = `app mode-${state.mode}`;
  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === state.mode);
  });

  const views = {
    desktop: renderDesktop,
    tablet: renderTablet,
    phone: renderPhone,
    tsd: renderTsd
  };
  if (state.loading) {
    root.innerHTML = `<section class="panel loading-panel"><h2>Загрузка приемки</h2><p class="muted">${escapeHtml(state.lastMessage)}</p></section>`;
  } else if (state.loadError) {
    root.innerHTML = `<section class="panel loading-panel"><h2>Приемка не загрузилась</h2><p class="bad-text">${escapeHtml(state.loadError)}</p><div class="actions"><button data-action="reload-supplies">Повторить</button></div></section>`;
  } else {
    root.innerHTML = views[state.mode]();
  }
  bindDynamicEvents();
  focusScanner();
}

function renderKpis() {
  if (!state.supplySelected) return "";
  const plan = totalPlan();
  const fact = totalFact();
  const open = state.boxes.filter((box) => box.status === "active").length;
  const closed = state.boxes.filter((box) => box.status === "closed").length;
  return `<section class="kpis">
    <div class="kpi"><span>Поставка</span><strong>${state.supply.code}</strong></div>
    <div class="kpi"><span>План</span><strong>${plan}</strong></div>
    <div class="kpi"><span>Факт</span><strong>${fact}</strong></div>
    <div class="kpi"><span>Остаток</span><strong>${plan - fact}</strong></div>
    <div class="kpi"><span>Активно коробов</span><strong>${open}</strong></div>
    <div class="kpi"><span>Ошибки</span><strong>${state.errors.length}</strong></div>
  </section>`;
}

function renderDesktop() {
  if (!state.supplySelected) return `${renderSupplyPanel()}${renderStartHint()}`;
  return `${renderSupplyPanel()}
  ${renderKpis()}
  <section class="desktop-grid">
    <aside class="side-stack">
      ${renderBoxPanel()}
    </aside>
    <section class="main-stack">
      ${renderToolbar()}
      ${renderItemsTable()}
      ${renderMatrix()}
      ${renderEventsPanel()}
    </section>
  </section>`;
}

function renderSupplyPanel() {
  const disabled = state.supplySelected ? "" : "disabled";
  return `<section class="panel supply-panel">
    <h2>Параметры поставки</h2>
    <div class="form-grid">
      <label class="span-2">Поставка ${renderSupplySelect()}</label>
      <label>Клиент <input data-field="client" value="${escapeAttr(state.supply.client)}" ${disabled}></label>
      <label>Дата <input data-field="date" type="date" value="${escapeAttr(state.supply.date)}" ${disabled}></label>
      <label>Смена ${renderOptionSelect("shift", state.formOptions.shifts, state.supply.shift, disabled)}</label>
      <label>Оператор ${renderOptionSelect("operator", state.formOptions.operators, state.supply.operator, disabled)}</label>
      <label>Приемщик ${renderOptionSelect("receiver", state.formOptions.receivers, state.supply.receiver, disabled)}</label>
      <label>Тип товара ${renderOptionSelect("productType", state.formOptions.productTypes, state.supply.productType, disabled)}</label>
      <label>Чья тара ${renderOptionSelect("tareOwner", state.formOptions.tareOwners, state.supply.tareOwner, disabled)}</label>
      <label>Паллеты <input data-field="pallets" type="number" min="0" step="1" value="${escapeAttr(state.supply.pallets)}" ${disabled}></label>
      <label class="span-2">Доп. услуги <input data-field="extraCharge" value="${escapeAttr(state.supply.extraCharge)}" ${disabled}></label>
      <label class="span-2">Комментарий <input data-field="comment" value="${escapeAttr(state.supply.comment)}" ${disabled}></label>
    </div>
  </section>`;
}

function renderStartHint() {
  return `<section class="panel start-hint">
    <h2>Выберите поставку</h2>
    <p class="muted">После выбора загрузится состав заявки и будут подготовлены 9 закрытых коробов с габаритами 60 x 40 x 40 см.</p>
  </section>`;
}

function renderSupplySelect() {
  const options = state.supplyOptions.length
    ? state.supplyOptions
    : [];
  return `<select class="supply-select"><option value="">Выберите поставку</option>${options.map((supply) => {
    const code = supply.code || supply.id;
    const label = supply.label || `${code} - ${supply.client || ""}`;
    const meta = supply.countsLoaded || supply.unitsTotal
      ? ` | ${Number(supply.skuCount || 0)} SKU | ${Number(supply.unitsTotal || 0)} шт`
      : " | считаем SKU...";
    return `<option value="${escapeAttr(label)}" ${code === state.supply.code ? "selected" : ""}>${escapeHtml(label + meta)}</option>`;
  }).join("")}</select>`;
}

function renderOptionSelect(field, options = [], value = "", disabled = "") {
  const uniq = Array.from(new Set([value, ...options].filter((item) => item !== undefined && item !== null)));
  return `<select data-field="${field}" ${disabled}>${uniq.map((option) => `<option value="${escapeAttr(option)}" ${String(option) === String(value) ? "selected" : ""}>${escapeHtml(option || "—")}</option>`).join("")}</select>`;
}

function renderToolbar() {
  return `<section class="panel toolbar">
    <div class="scan-row">
      <label>Активный короб ${renderBoxSelect()}</label>
      <label>Сканер / ручной ввод <input class="scanner-input" placeholder="Сканируйте короб или товар" autocomplete="off"></label>
      <button data-action="scan">Скан</button>
      <button class="secondary" data-action="demo-scan">Тест SKU</button>
    </div>
    <div class="actions">
      <button data-action="create-boxes">Добавить 9 коробов</button>
      <button data-action="print-all">Печать всех этикеток</button>
      <button class="warn" data-action="close-active">Закрыть активный</button>
    </div>
  </section>`;
}

function renderBoxSelect() {
  return `<select class="active-box-select"><option value="">Сканируйте короб</option>${state.boxes.map((box) => `<option value="${box.code}" ${box.code === state.activeBoxCode ? "selected" : ""}>${box.code} ${statusText(box)}</option>`).join("")}</select>`;
}

function renderBoxPanel(limit = 80) {
  const boxes = state.boxes.slice(0, limit).map((box) => `<article class="box-card ${box.code === state.activeBoxCode ? "active" : ""}">
    <div class="box-head">
      <div>
        <div class="code">${box.code}</div>
        <div class="small muted">SKU: ${Object.keys(box.items).length} | шт: ${boxQty(box)} | ${tareLabel(box.dims)}</div>
      </div>
      <span class="pill ${statusClass(box)}">${statusText(box)}</span>
    </div>
    <div class="actions">
      <button class="secondary" data-action="select-box" data-code="${box.code}">${box.code === state.activeBoxCode ? "Закрыть" : "Открыть"}</button>
      <button class="secondary" data-action="print-box" data-code="${box.code}">Этикетка</button>
      <button class="secondary" data-action="composition" data-code="${box.code}">Состав</button>
      <button class="warn" data-action="close-box" data-code="${box.code}" ${box.code === state.activeBoxCode ? "" : "disabled"}>Закрыть</button>
    </div>
  </article>`).join("");
  return `<section class="panel">
    <h2>Короба</h2>
    <div class="box-list">${boxes || "<p class='muted'>Короба еще не созданы</p>"}</div>
  </section>`;
}

function renderItemsTable() {
  return `<section class="panel">
    <h2>Товары из заявки</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>SKU</th><th>Баркод</th><th>Короткий</th><th class="num">План</th><th class="num">Факт</th><th class="num">Остаток</th><th>Габариты</th><th>Действия</th></tr></thead>
        <tbody>${state.items.map((item) => {
          const fact = factForItem(item.id);
          const rem = item.plan - fact;
          return `<tr>
            <td>${escapeHtml(item.sku)}</td>
            <td>${item.barcode}</td>
            <td><strong>${item.barcode.slice(-5)}</strong></td>
            <td class="num">${item.plan}</td>
            <td class="num">${fact}</td>
            <td class="num ${rem ? "bad-text" : "ok"}">${rem}</td>
            <td>${item.dims.w}x${item.dims.d}x${item.dims.h}, ${item.weight} г</td>
            <td class="row-actions">
              <button class="secondary" data-action="add-item" data-item="${item.id}">+1</button>
              <button class="secondary" data-action="add-qty" data-item="${item.id}">+ кол-во</button>
            </td>
          </tr>`;
        }).join("")}</tbody>
      </table>
    </div>
  </section>`;
}

function renderMatrix() {
  const boxes = state.boxes.slice(0, 15);
  return `<section class="panel">
    <h2>Матрица коробов</h2>
    <div class="table-wrap">
      <table class="matrix">
        <thead><tr><th>SKU</th><th>План</th><th>Факт</th>${boxes.map((box) => `<th>${box.index}</th>`).join("")}</tr></thead>
        <tbody>${state.items.map((item) => `<tr>
          <td>${escapeHtml(item.sku)}</td><td>${item.plan}</td><td>${factForItem(item.id)}</td>
          ${boxes.map((box) => {
            const row = box.items[item.id];
            return `<td>${row ? row.qty : ""}</td>`;
          }).join("")}
        </tr>`).join("")}</tbody>
      </table>
    </div>
  </section>`;
}

function renderEventsPanel() {
  return `<section class="panel">
    <h2>Журнал</h2>
    <div class="box-list">${state.events.slice(0, 12).map((event) => `<div class="event-card small"><strong>${event.at}</strong> ${escapeHtml(event.text)} <span class="muted">(${event.source})</span></div>`).join("") || "<p class='muted'>Событий пока нет</p>"}</div>
  </section>`;
}

function renderTablet() {
  if (!state.supplySelected) return `${renderSupplyPanel()}${renderStartHint()}`;
  return `${renderSupplyPanel()}
  ${renderKpis()}
  <section class="tablet-layout">
    <div class="tablet-primary">
      ${renderTabletScan()}
      ${renderTabletTabs()}
      ${renderTabletTabContent()}
    </div>
    ${renderBoxPanel(30)}
  </section>`;
}

function renderTabletScan() {
  const box = boxByCode(state.activeBoxCode);
  const boxCode = box ? box.code : "не выбран";
  const boxPill = box ? statusText(box) : "Скан короба";
  const boxClass = box ? statusClass(box) : "gray";
  return `<section class="scan-card">
    <div class="active-box">
      <div class="active-box-title"><span>Активный короб</span><strong>${boxCode}</strong></div>
      <span class="pill ${boxClass}">${boxPill}</span>
    </div>
    ${box ? renderBoxDimsEditor(box) : ""}
    <input class="scanner-input scan-input" placeholder="Скан коробки или товара" autocomplete="off">
    <p class="small muted" style="margin-top:8px">${escapeHtml(state.lastMessage)}</p>
    ${box ? renderActiveBoxContents(box) : ""}
    <div class="actions">
      <button data-action="scan">Обработать</button>
      <button class="secondary" data-action="demo-box">Скан короб</button>
      <button class="secondary" data-action="demo-scan">Скан товар</button>
      <button class="warn" data-action="close-active">Закрыть короб</button>
    </div>
  </section>`;
}

function renderBoxDimsEditor(box) {
  return `<div class="box-dims">
    <label>Глубина, см <input data-box-dim="d" type="number" min="1" step="1" value="${escapeAttr(box.dims.d)}"></label>
    <label>Ширина, см <input data-box-dim="w" type="number" min="1" step="1" value="${escapeAttr(box.dims.w)}"></label>
    <label>Высота, см <input data-box-dim="h" type="number" min="1" step="1" value="${escapeAttr(box.dims.h)}"></label>
    <div class="dim-summary"><span>Тара</span><strong>${tareLabel(box.dims)}</strong></div>
  </div>`;
}

function renderActiveBoxContents(box) {
  const rows = objectValues(box.items);
  const content = rows.length
    ? rows.map((row) => `<div class="content-row"><span>${escapeHtml(row.sku)}</span><strong>${row.qty}</strong></div>`).join("")
    : "<p class='muted small'>В активном коробе пока пусто.</p>";
  return `<div class="active-content">
    <div class="active-content-head"><span>Содержимое</span><strong>${rows.length} SKU / ${boxQty(box)} шт</strong></div>
    ${content}
  </div>`;
}

function renderTabletTabs() {
  const tabs = [["scan", "Скан"], ["items", "Товары"], ["boxes", "Короба"], ["errors", "Ошибки"]];
  return `<nav class="tablet-tabs">${tabs.map(([id, text]) => `<button class="tab-btn ${state.tab === id ? "active" : ""}" data-tab="${id}">${text}</button>`).join("")}</nav>`;
}

function renderTabletTabContent() {
  if (state.tab === "boxes") return renderBoxPanel(50);
  if (state.tab === "errors") return renderErrors();
  if (state.tab === "items" || state.tab === "scan") return `<section class="panel"><h2>Остатки по товарам</h2><div class="cards-grid">${renderItemCards()}</div></section>`;
  return "";
}

function renderItemCards() {
  return state.items.map((item) => {
    const fact = factForItem(item.id);
    const rem = item.plan - fact;
    return `<article class="item-card">
      <div class="item-head"><strong>${escapeHtml(item.sku)}</strong><span class="pill ${rem ? "warn" : ""}">${rem ? `ост ${rem}` : "готово"}</span></div>
      <div class="small muted">${item.barcode} | короткий ${item.barcode.slice(-5)}</div>
      <div class="actions">
        <button class="secondary" data-action="add-item" data-item="${item.id}">+1</button>
        <button class="secondary" data-action="add-qty" data-item="${item.id}">+ кол-во</button>
      </div>
    </article>`;
  }).join("");
}

function renderErrors() {
  return `<section class="panel"><h2>Ошибки</h2><div class="box-list">${state.errors.map((err) => `<article class="error-card"><strong class="bad-text">${err.at}</strong><div>${escapeHtml(err.message)}</div><div class="small muted">${err.code}</div></article>`).join("") || "<p class='muted'>Ошибок нет</p>"}</div></section>`;
}

function renderPhone() {
  if (!state.supplySelected) return `<section class="phone-shell">${renderSupplyPanel()}${renderStartHint()}</section>`;
  return `<section class="phone-shell">
    <div class="phone-summary">${renderMiniKpis()}</div>
    ${renderSupplyPanel()}
    ${renderTabletScan()}
    ${renderTabletTabs()}
    ${renderTabletTabContent()}
  </section>`;
}

function renderMiniKpis() {
  return `<div class="kpi"><span>Факт</span><strong>${totalFact()}</strong></div><div class="kpi"><span>Ост</span><strong>${totalPlan() - totalFact()}</strong></div><div class="kpi"><span>Ошибки</span><strong>${state.errors.length}</strong></div>`;
}

function renderTsd() {
  if (!state.supplySelected) return `<section class="tsd-shell">${renderSupplyPanel()}</section>`;
  const box = boxByCode(state.activeBoxCode);
  const boxCode = box ? box.code : "НЕТ";
  const boxStatus = box ? `${statusText(box)} | шт: ${boxQty(box)}` : "Сканируйте QR короба";
  return `<section class="tsd-shell">
    <div class="tsd-status">
      <div class="label">Активный короб</div>
      <strong>${boxCode}</strong>
      <div class="small">${boxStatus}</div>
    </div>
    <input class="scanner-input tsd-input" placeholder="СКАН" autocomplete="off">
    <div class="tsd-last">
      <div class="small muted">Последнее действие</div>
      <h2>${escapeHtml(state.lastMessage)}</h2>
      <div class="small muted">План ${totalPlan()} | факт ${totalFact()} | ост ${totalPlan() - totalFact()}</div>
    </div>
    <div class="tsd-actions">
      <button data-action="scan">Enter</button>
      <button class="secondary" data-action="demo-box">Короб</button>
      <button class="secondary" data-action="demo-scan">Товар</button>
      <button class="warn" data-action="close-active">Закрыть</button>
    </div>
  </section>`;
}

function bindDynamicEvents() {
  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.onclick = () => {
      state.mode = btn.dataset.mode;
      localStorage.setItem("receiving.mode", state.mode);
      render();
    };
  });

  document.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.onclick = () => {
      state.tab = btn.dataset.tab;
      render();
    };
  });

  document.querySelectorAll("[data-field]").forEach((input) => {
    input.onchange = () => {
      state.supply[input.dataset.field] = input.value;
      logEvent("supply_updated", `Обновлено поле ${input.dataset.field}`);
      render();
    };
  });

  const supplySelect = $(".supply-select");
  if (supplySelect) {
    supplySelect.onchange = () => {
      if (supplySelect.value) loadBootstrap(supplySelect.value);
    };
  }

  const select = $(".active-box-select");
  if (select) {
    select.onchange = () => {
      openBox(boxByCode(select.value));
      render();
    };
  }

  document.querySelectorAll("[data-box-dim]").forEach((input) => {
    input.onchange = () => {
      const box = boxByCode(state.activeBoxCode);
      if (!box) return;
      box.dims[input.dataset.boxDim] = sanitizeInt(input.value, DEFAULT_DIMS[input.dataset.boxDim]);
      logEvent("box_dims_updated", `Габариты ${box.code}: ${box.dims.d}x${box.dims.w}x${box.dims.h}`);
      render();
    };
  });

  document.querySelectorAll("[data-action]").forEach((el) => {
    el.onclick = () => runAction(el.dataset.action, el.dataset);
  });

  document.querySelectorAll(".scanner-input").forEach((input) => {
    input.onkeydown = (event) => {
      if (event.key !== "Enter") return;
      state.scanBuffer = input.value;
      processScan(input.value);
      input.value = "";
      render();
    };
  });
}

function runAction(action, data = {}) {
  const input = $(".scanner-input");
  if (action === "reload-supplies") {
    loadSupplyOptions();
    return;
  }
  if (action === "scan") {
    processScan((input && input.value) || state.scanBuffer);
    if (input) input.value = "";
  }
  if (action === "demo-box") processScan(state.boxes[0] ? state.boxes[0].code : "");
  if (action === "demo-scan") processScan(state.items[0] ? state.items[0].barcode : "");
  if (action === "create-boxes") createBoxes(9);
  if (action === "print-all") printLabels(state.boxes);
  if (action === "print-box") printLabels([boxByCode(data.code)].filter(Boolean));
  if (action === "composition") {
    const box = boxByCode(data.code);
    if (box) printComposition(box);
  }
  if (action === "select-box") {
    openBox(boxByCode(data.code));
  }
  if (action === "close-box") closeBox(boxByCode(data.code));
  if (action === "close-active") closeBox(boxByCode(state.activeBoxCode));
  if (action === "add-item") {
    const item = state.items.find((x) => x.id === data.item);
    addItemToBox(item, boxByCode(state.activeBoxCode), 1, "manual");
  }
  if (action === "add-qty") {
    const item = state.items.find((x) => x.id === data.item);
    const rem = item ? item.plan - factForItem(item.id) : 0;
    const raw = prompt(`Сколько добавить в активный короб? Остаток: ${rem}`, String(Math.min(rem || 1, 10)));
    if (raw !== null) addItemToBox(item, boxByCode(state.activeBoxCode), sanitizeInt(raw, 1), "manual_qty");
  }
  render();
}

function focusScanner() {
  const input = $(".scanner-input");
  if (input && state.mode === "tsd") {
    setTimeout(() => {
      try {
        input.focus({ preventScroll: true });
      } catch {
        input.focus();
      }
    }, 0);
  }
}

printLabels = ((original) => (targets) => {
  original(targets);
  render();
})(printLabels);
window.__receivingState = state;
window.__receivingProcessScan = (code) => {
  processScan(code);
  render();
};
loadSupplyOptions();
