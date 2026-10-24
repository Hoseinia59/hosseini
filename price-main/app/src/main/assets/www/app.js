'use strict';

const DB_NAME = 'YadakPriceMobile';
const DB_VERSION = 2;
const PAGE_SIZE = 40;

let db, toastTimer, installPrompt = null;
let productPage = 1, historyPage = 1;
let pendingImport = null;

const $ = id => document.getElementById(id);
const now = () => new Date().toLocaleString('fa-IR');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function norm(v) {
  return String(v ?? '')
    .toLowerCase()
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[ۀة]/g, 'ه')
    .replace(/ـ/g, '')
    .replace(/[.\-_/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function faNum(v) {
  return String(v ?? '')
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
}

function num(v) {
  let s = faNum(v).replace(/[٬,،\s]/g, '').replace(/ریال|تومان/g, '').replace(/٫/g, '.');
  if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function fmt(v) {
  return Math.round(Number(v) || 0).toLocaleString('fa-IR');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function notify(s) {
  if (!$('toast')) return;
  $('toast').textContent = s;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3200);
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('products')) {
        const s = d.createObjectStore('products', { keyPath: 'id' });
        s.createIndex('code', 'code', { unique: false });
        s.createIndex('oem', 'oem', { unique: false });
        s.createIndex('barcode', 'barcode', { unique: false });
      }

      for (const [name, key] of [['rules', 'id'], ['history', 'id'], ['settings', 'key'], ['sources', 'id']]) {
        if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: key });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function all(store) {
  return new Promise((res, rej) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  });
}

function get(store, key) {
  return new Promise((res, rej) => {
    const r = db.transaction(store).objectStore(store).get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function put(store, value) {
  return new Promise((res, rej) => {
    const t = db.transaction(store, 'readwrite');
    t.objectStore(store).put(value);
    t.oncomplete = () => res(value);
    t.onerror = () => rej(t.error);
  });
}

function putMany(store, values) {
  if (!values || values.length === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(store, 'readwrite');
      const objectStore = tx.objectStore(store);

      for (const value of values) objectStore.put(value);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    } catch (err) {
      reject(err);
    }
  });
}

function del(store, key) {
  return new Promise((res, rej) => {
    const t = db.transaction(store, 'readwrite');
    t.objectStore(store).delete(key);
    t.oncomplete = res;
    t.onerror = () => rej(t.error);
  });
}

function clearStore(store) {
  return new Promise((res, rej) => {
    const t = db.transaction(store, 'readwrite');
    t.objectStore(store).clear();
    t.oncomplete = res;
    t.onerror = () => rej(t.error);
  });
}

async function setting(key, def) {
  const x = await get('settings', key);
  return x ? x.value : def;
}

function levenshtein(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i][j - 1], dp[i - 1][j]);
    }
  }
  return dp[a.length][b.length];
}

function matchTier(p, qWords, qNorm) {
  const name = norm(p.name), brand = norm(p.brand), cars = norm((p.cars || []).join(' ')), code = norm(p.code), oem = norm(p.oem), barcode = norm(p.barcode), alt = norm((p.altNames || []).join(' '));

  if (qNorm && (code === qNorm || oem === qNorm) && (code || oem)) return 0;
  if (qNorm && barcode && barcode === qNorm) return 1;
  if (qNorm && name === qNorm) return 2;

  const inName = w => name.includes(w);
  const inNameBrand = w => name.includes(w) || brand.includes(w);
  const inNameCar = w => name.includes(w) || cars.includes(w);
  const inAlt = w => alt.includes(w);
  const inAny = w => name.includes(w) || brand.includes(w) || cars.includes(w) || code.includes(w) || oem.includes(w) || barcode.includes(w);

  if (qWords.every(inName)) return 3;
  if (qWords.every(inNameBrand)) return 4;
  if (qWords.every(inNameCar)) return 5;
  if (qWords.every(inAlt)) return 6;
  if (qWords.every(inAny)) return 7;

  return null;
}

function searchProducts(products, query) {
  const qNorm = norm(query);
  if (!qNorm) return products.slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name), 'fa'));

  const qWords = qNorm.split(' ').filter(Boolean);
  const scored = [];
  const unmatched = [];

  for (const p of products) {
    const tier = matchTier(p, qWords, qNorm);
    if (tier !== null) scored.push({ p, tier });
    else unmatched.push(p);
  }

  if (qWords.length === 1 && qWords[0].length >= 3 && qWords[0].length <= 20) {
    const maxDist = qWords[0].length <= 5 ? 1 : 2;
    for (const p of unmatched) {
      const hit = norm(p.name).split(' ').some(t => t.length >= 3 && levenshtein(t, qWords[0], maxDist) <= maxDist);
      if (hit) scored.push({ p, tier: 8 });
    }
  }

  scored.sort((a, b) => a.tier - b.tier || norm(a.p.name).localeCompare(norm(b.p.name), 'fa'));
  return scored.map(x => x.p);
}

function isFinalPrice(p) {
  return p.priceType === 'final';
}

function matchedRule(p, rules) {
  const name = norm(p.name), brand = norm(p.brand);
  const matches = rules.filter(r => {
    const termOk = !r.term || name.includes(norm(r.term));
    const brandOk = !r.brand || brand.includes(norm(r.brand));
    return (r.term || r.brand) && termOk && brandOk;
  });

  if (!matches.length) return null;
  matches.sort((a, b) => (norm(b.term).length + norm(b.brand).length) - (norm(a.term).length + norm(a.brand).length));
  return matches[0];
}

function profitInfo(p, rules, defaultProfit) {
  if (isFinalPrice(p)) return { percent: 0, origin: 'final', label: 'قیمت نهایی · بدون سود' };
  if (p.itemProfitPercent !== null && p.itemProfitPercent !== undefined && p.itemProfitPercent !== '') {
    return { percent: Number(p.itemProfitPercent), origin: 'item', label: `سود اختصاصی ${fmt(Number(p.itemProfitPercent))}%` };
  }
  const rule = matchedRule(p, rules);
  if (rule) {
    return { percent: Number(rule.percent), origin: 'group', label: `قاعده (${[rule.term, rule.brand].filter(Boolean).join(' ')}) ${fmt(rule.percent)}٪` };
  }
  return { percent: Number(defaultProfit), origin: 'default', label: `سود پیش‌فرض ${fmt(defaultProfit)}٪` };
}

function sellPrice(p, rules, defaultProfit) {
  if (isFinalPrice(p)) return Number(p.basePrice) || 0;
  return Math.round((Number(p.basePrice) || 0) * (1 + profitInfo(p, rules, defaultProfit).percent / 100));
}

async function renderHomeSearchResults() {
  const input = document.getElementById('homeSearch');
  const resultsBox = document.getElementById('homeSearchResults');

  if (!input || !resultsBox) return;

  const query = input.value.trim();
  const products = await all('products');
  const rules = await all('rules');
  const defaultProfit = await setting('defaultProfit', 15);

  let filtered = query ? searchProducts(products, query) : products.slice(0, 6);

  if (!filtered.length) {
    resultsBox.innerHTML = '<div class="empty-result">هیچ نتیجه‌ای پیدا نشد.</div>';
    return;
  }

  filtered = filtered.slice(0, 8);

  resultsBox.innerHTML = filtered.map(p => {
    const price = sellPrice(p, rules, defaultProfit);
    return `
      <div class="search-result-card" data-id="${p.id}">
        <div class="result-name">${esc(p.name)}</div>
        <div class="result-meta">
          ${p.brand ? `<span class="result-pill">${esc(p.brand)}</span>` : ''}
          ${p.code ? `<span class="result-pill">${esc(p.code)}</span>` : ''}
          ${p.oem ? `<span class="result-pill">OEM: ${esc(p.oem)}</span>` : ''}
        </div>
        <div class="result-price">${fmt(price)} ریال</div>
      </div>
    `;
  }).join('');

  resultsBox.querySelectorAll('.search-result-card').forEach(item => {
    item.onclick = () => {
      const id = item.dataset.id;
      const product = products.find(p => p.id === id);
      if (!product) return;

      const searchInput = document.getElementById('search');
      if (searchInput) {
        searchInput.value = product.name;
      }

      if (window.goToPage) {
        window.goToPage('products');
      }

      setTimeout(async () => {
        const searchInput2 = document.getElementById('search');
        if (searchInput2) {
          searchInput2.value = product.name;
          await renderProducts(true);
        }
      }, 120);
    };
  });
}

async function renderProducts(resetPage) {
  if (resetPage) productPage = 1;
  const rows = await getFiltered();

  if ($('countStat')) $('countStat').textContent = `${fmt(rows.length)} کالا`;

  const visible = rows.slice(0, productPage * PAGE_SIZE);

  if ($('productList')) {
    $('productList').innerHTML = visible.map(({ p, sell, info }) => `
      <article class="product-card">
        <div class="product-title">${esc(p.name)}</div>
        <div class="product-meta">
          ${p.brand ? `<span class="pill">برند: ${esc(p.brand)}</span>` : ''}
          ${(p.cars && p.cars.length) ? `<span class="pill">خودرو: ${esc(p.cars.join('، '))}</span>` : ''}
          ${p.code ? `<span class="pill">کد: ${esc(p.code)}</span>` : ''}
          ${p.oem ? `<span class="pill">OEM: ${esc(p.oem)}</span>` : ''}
          ${p.barcode ? `<span class="pill">بارکد: ${esc(p.barcode)}</span>` : ''}
          <span class="pill ${info.origin === 'final' ? 'final' : (info.origin === 'item' ? 'manual' : '')}">${esc(info.label)}</span>
        </div>
        <div class="price-row">
          <div>
            <div class="price">${fmt(sell)} <small>ریال</small></div>
            <div class="subprice">قیمت پایه: ${fmt(p.basePrice)} · ${esc(p.priceType === 'final' ? 'قیمت نهایی' : 'قیمت پایه')}</div>
          </div>
          <span class="pill">${esc(p.source || 'ورود دستی')}</span>
        </div>
        <div class="card-actions">
          <button class="small-btn" data-edit="${p.id}">ویرایش</button>
          <button class="small-btn" data-hist="${p.id}">تغییرات</button>
          <button class="small-btn" data-delete="${p.id}">حذف</button>
        </div>
      </article>
    `).join('');

    $('productList').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editProduct(b.dataset.edit));
    $('productList').querySelectorAll('[data-hist]').forEach(b => b.onclick = () => showProductHistory(b.dataset.hist));
    $('productList').querySelectorAll('[data-delete]').forEach(b => b.onclick = () => deleteProduct(b.dataset.delete));
  }

  if ($('emptyProducts')) {
    $('emptyProducts').classList.toggle('hidden', rows.length > 0);
    $('emptyProducts').textContent = ($('search') && $('search').value.trim()) ? 'نتیجه‌ای پیدا نشد.' : 'هنوز کالایی ثبت نشده است.';
  }

  if ($('loadMoreBtn')) $('loadMoreBtn').classList.toggle('hidden', visible.length >= rows.length);

  await populateFilterOptions();
}

async function getFiltered() {
  const products = await all('products');
  let rows = searchProducts(products, $('search') ? $('search').value : '');

  const brand = $('filterBrand') ? $('filterBrand').value : '';
  const source = $('filterSource') ? $('filterSource').value : '';
  const ptype = $('filterPriceType') ? $('filterPriceType').value : '';
  const minP = $('filterMinPrice') ? Number($('filterMinPrice').value || 0) : 0;
  const maxP = $('filterMaxPrice') ? Number($('filterMaxPrice').value || 0) : 0;
  const hasCode = $('filterHasCode') ? $('filterHasCode').checked : false;

  if (brand) rows = rows.filter(p => p.brand === brand);
  if (source) rows = rows.filter(p => p.source === source);
  if (ptype) rows = rows.filter(p => (p.priceType || 'base') === ptype);
  if (hasCode) rows = rows.filter(p => !!p.code);

  const rules = await all('rules');
  const defaultProfit = await setting('defaultProfit', 15);

  let withPrice = rows.map(p => ({
    p,
    sell: sellPrice(p, rules, defaultProfit),
    info: profitInfo(p, rules, defaultProfit)
  }));

  if (minP > 0) withPrice = withPrice.filter(x => x.sell >= minP);
  if (maxP > 0) withPrice = withPrice.filter(x => x.sell <= maxP);

  return withPrice;
}

async function populateFilterOptions() {
  const products = await all('products');
  const brands = [...new Set(products.map(p => p.brand).filter(Boolean))].sort((a, b) => norm(a).localeCompare(norm(b), 'fa'));
  const sources = [...new Set(products.map(p => p.source).filter(Boolean))].sort((a, b) => norm(a).localeCompare(norm(b), 'fa'));

  const fillSelect = (sel, items, current) => {
    if (!sel) return;
    sel.innerHTML = sel.querySelector('option').outerHTML + items.map(v => `<option ${v === current ? 'selected' : ''}>${esc(v)}</option>`).join('');
  };

  fillSelect($('filterBrand'), brands, $('filterBrand') ? $('filterBrand').value : '');
  fillSelect($('filterSource'), sources, $('filterSource') ? $('filterSource').value : '');
}

function showModal(title, html) {
  if ($('modalTitle')) $('modalTitle').textContent = title;
  if ($('modalBody')) $('modalBody').innerHTML = html;
  if ($('modalBackdrop')) $('modalBackdrop').classList.remove('hidden');
}

function closeModal() {
  if ($('modalBackdrop')) $('modalBackdrop').classList.add('hidden');
}

if ($('closeModal')) $('closeModal').onclick = closeModal;
if ($('modalBackdrop')) $('modalBackdrop').onclick = e => {
  if (e.target === $('modalBackdrop')) closeModal();
};

async function deleteProduct(id) {
  const p = await get('products', id);
  if (!p || !confirm('حذف شود؟')) return;
  await del('products', id);
  await renderProducts(true);
  notify('حذف شد');
}

async function editProduct(id) {
  const p = id ? await get('products', id) : {
    id: uid(),
    name: '',
    altNames: [],
    brand: '',
    cars: [],
    code: '',
    oem: '',
    barcode: '',
    basePrice: 0,
    priceType: 'base',
    itemProfitPercent: '',
    source: '',
    priceNote: ''
  };

  showModal(id ? 'ویرایش کالا' : 'ثبت کالای جدید', `
    <form id="productForm" class="modal-form">
      <label>نام کالا * <input name="name" required value="${esc(p.name)}"></label>
      <div class="two"><label>برند<input name="brand" value="${esc(p.brand)}"></label><label>کد فنی<input name="code" value="${esc(p.code)}"></label></div>
      <div class="two"><label>بارکد<input name="barcode" value="${esc(p.barcode)}"></label><label>قیمت پایه (ریال) *<input name="basePrice" inputmode="decimal" required value="${esc(p.basePrice)}"></label></div>
      <div class="two"><label>نوع قیمت<select name="priceType"><option value="base" ${p.priceType !== 'final' ? 'selected' : ''}>قیمت پایه</option><option value="final" ${p.priceType === 'final' ? 'selected' : ''}>قیمت نهایی</option></select></label><label>سود اختصاصی (%)<input name="itemProfitPercent" value="${esc(p.itemProfitPercent ?? '')}"></label></div>
      <div class="two"><label>منبع قیمت<input name="source" value="${esc(p.source || '')}"></label><label>خودرو/گروه<input name="cars" value="${esc((p.cars || []).join(', '))}"></label></div>
      <div class="modal-actions"><button class="primary-btn" type="submit">ذخیره کالا</button><button class="small-btn" type="button" id="cancelProduct">انصراف</button></div>
    </form>
  `);

  if ($('cancelProduct')) $('cancelProduct').onclick = closeModal;

  if ($('productForm')) {
    $('productForm').onsubmit = async e => {
      e.preventDefault();
      const f = new FormData(e.target);

      const next = {
        ...p,
        name: String(f.get('name')).trim(),
        brand: String(f.get('brand')).trim(),
        code: String(f.get('code')).trim(),
        barcode: String(f.get('barcode')).trim(),
        basePrice: num(f.get('basePrice')),
        priceType: String(f.get('priceType')) === 'final' ? 'final' : 'base',
        itemProfitPercent: String(f.get('itemProfitPercent') ?? '').trim(),
        source: String(f.get('source') ?? '').trim(),
        cars: String(f.get('cars') ?? '').split(',').map(x => x.trim()).filter(Boolean)
      };

      if (!next.name || next.basePrice <= 0) return notify('نام کالا و قیمت معتبر نیست.');

      await put('products', next);
      closeModal();
      await renderProducts(true);
      notify('ذخیره شد.');
    };
  }
}

async function renderRules() {
  const rs = (await all('rules')).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  if ($('ruleList')) {
    $('ruleList').innerHTML = rs.map(r => `
      <div class="list-row">
        <b>${esc(r.term)} ${r.brand ? '· ' + esc(r.brand) : ''}</b>
        <small>سود ${fmt(r.percent)}٪</small>
        <button class="small-btn" data-rdel="${r.id}">حذف</button>
      </div>
    `).join('');

    $('ruleList').querySelectorAll('[data-rdel]').forEach(b => b.onclick = async () => {
      await del('rules', b.dataset.rdel);
      await renderRules();
      await renderProducts(true);
      notify('حذف شد');
    });
  }
}

if ($('ruleForm')) {
  $('ruleForm').onsubmit = async e => {
    e.preventDefault();
    const term = $('ruleTerm').value.trim();
    const brand = $('ruleBrand').value.trim();
    const percent = Number($('rulePercent').value);

    if (!term && !brand) return notify('نام کالا یا برند الزامی است.');
    await put('rules', { id: uid(), term, brand, percent, createdAt: new Date().toISOString() });

    e.target.reset();
    $('rulePercent').value = 10;
    await renderRules();
    await renderProducts(true);
    notify('قاعده ثبت شد');
  };
}

async function renderHistory(resetPage) {
  if (resetPage) historyPage = 1;

  let hs = (await all('history')).sort((a, b) => b.at.localeCompare(a.at));
  const q = $('historySearch') ? norm($('historySearch').value) : '';

  if (q) hs = hs.filter(h => norm([h.productName, h.field, h.oldValue, h.newValue].join(' ')).includes(q));

  const visible = hs.slice(0, historyPage * 60);

  if ($('historyList')) {
    $('historyList').innerHTML = visible.map(h => `
      <div class="list-row">
        <b>${esc(h.productName)} · ${esc(h.field)}</b>
        <small>${esc(h.displayAt || h.at)}</small>
        <div>${esc(h.oldValue)} → ${esc(h.newValue)}</div>
      </div>
    `).join('');
  }

  if ($('historyMoreBtn')) $('historyMoreBtn').classList.toggle('hidden', visible.length >= hs.length);
}

if ($('historyMoreBtn')) $('historyMoreBtn').onclick = () => { historyPage++; renderHistory(false); };
if ($('historySearch')) $('historySearch').oninput = () => renderHistory(true);

if ($('clearHistory')) {
  $('clearHistory').onclick = async () => {
    if (confirm('پاک شود؟')) {
      await clearStore('history');
      await renderHistory(true);
    }
  };
}

function applyAppearance() {
  const root = document.documentElement;
  root.dataset.theme = localStorage.getItem('yadak_theme') || 'system';
  root.dataset.color = localStorage.getItem('yadak_color') || 'orange';
}

applyAppearance();

if ($('appearanceBtn')) {
  $('appearanceBtn').onclick = () => {
    const get = (k, f) => localStorage.getItem(k) || f;
    showModal('تنظیمات ظاهر', `
      <form id="appearanceForm" class="modal-form">
        <label>تم
          <select name="theme">
            <option value="system" ${get('yadak_theme', 'system') === 'system' ? 'selected' : ''}>سیستم</option>
            <option value="dark" ${get('yadak_theme', 'system') === 'dark' ? 'selected' : ''}>تیره</option>
            <option value="light" ${get('yadak_theme', 'system') === 'light' ? 'selected' : ''}>روشن</option>
          </select>
        </label>
        <label>رنگ اصلی
          <select name="color">
            <option value="orange" ${get('yadak_color', 'orange') === 'orange' ? 'selected' : ''}>نارنجی</option>
            <option value="blue" ${get('yadak_color', 'orange') === 'blue' ? 'selected' : ''}>آبی</option>
            <option value="green" ${get('yadak_color', 'orange') === 'green' ? 'selected' : ''}>سبز</option>
            <option value="purple" ${get('yadak_color', 'orange') === 'purple' ? 'selected' : ''}>بنفش</option>
          </select>
        </label>
        <button class="primary-btn" type="submit">ذخیره</button>
      </form>
    `);

    $('appearanceForm').onsubmit = e => {
      e.preventDefault();
      const f = new FormData(e.target);
      localStorage.setItem('yadak_theme', f.get('theme'));
      localStorage.setItem('yadak_color', f.get('color'));
      applyAppearance();
      closeModal();
      notify('ظاهر ذخیره شد');
    };
  };
}

if ($('settingsBtn')) {
  $('settingsBtn').onclick = async () => {
    const def = await setting('defaultProfit', 15);
    showModal('تنظیمات قیمت', `
      <form id="settingsForm" class="modal-form">
        <label>سود پیش‌فرض (%)
          <input name="profit" type="number" step="0.1" value="${esc(def)}">
        </label>
        <button class="primary-btn" type="submit">ذخیره قیمت</button>
      </form>
    `);

    $('settingsForm').onsubmit = async e => {
      e.preventDefault();
      await put('settings', { key: 'defaultProfit', value: Number(new FormData(e.target).get('profit')) });
      closeModal();
      await renderProducts(true);
      notify('تنظیمات ذخیره شد');
    };
  };
}

function download(name, content, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

if ($('exportCsv')) {
  $('exportCsv').onclick = async () => {
    const ps = await all('products');
    const lines = [['نام کالا', 'برند', 'کد فنی', 'قیمت پایه'], ...ps.map(p => [p.name, p.brand, p.code, p.basePrice])]
      .map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n');

    download('yadak-price.csv', '\uFEFF' + lines, 'text/csv;charset=utf-8');
    notify('خروجی آماده شد');
  };
}

if ($('backupBtn')) {
  $('backupBtn').onclick = async () => {
    const data = {
      app: 'YadakPriceMobile',
      version: DB_VERSION,
      products: await all('products'),
      rules: await all('rules'),
      history: await all('history'),
      settings: await all('settings'),
      sources: await all('sources')
    };

    download(`yadak-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json');
    notify('پشتیبان گرفته شد');
  };
}

if ($('restoreFile')) {
  $('restoreFile').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const d = JSON.parse(await file.text());
      if (d.app !== 'YadakPriceMobile') throw new Error('ساختار فایل معتبر نیست');

      if (!confirm('اطلاعات جایگزین شوند؟')) return;

      for (const s of ['products', 'rules', 'history', 'settings', 'sources']) {
        await clearStore(s);
        for (const row of (d[s] || [])) await put(s, row);
      }

      await refreshAll();
      notify('بازیابی شد');
    } catch (err) {
      notify('خطا: ' + err.message);
    } finally {
      e.target.value = '';
    }
  };
}

function detectHeaderAndMapping(rows) {
  const ALIASES = {
    name: ['نام کالا', 'شرح کالا', 'نام محصول', 'نام'],
    price: ['فی فروش', 'قیمت فروش', 'قیمت', 'فی', 'مبلغ'],
    brand: ['برند', 'Brand', 'Manufacturer'],
    code: ['کد فنی', 'کد', 'Code', 'کد کالا']
  };

  const hIndex = (headers, choices) => headers.findIndex(h => choices.some(c => norm(String(h)).includes(norm(c))));

  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const h = rows[i].map(x => String(x ?? ''));
    const n = hIndex(h, ALIASES.name);
    const p = hIndex(h, ALIASES.price);

    if (n >= 0 && p >= 0) {
      const map = { name: n, price: p, brand: hIndex(h, ALIASES.brand), code: hIndex(h, ALIASES.code) };
      return { headerRowIndex: i, headers: h, map };
    }
  }
  return null;
}

async function buildImportPreview(rows, fileName) {
  const detected = detectHeaderAndMapping(rows);
  const headerRowIndex = detected ? detected.headerRowIndex : 0;
  const headers = detected ? detected.headers : (rows[0] || []).map((_, i) => `ستون ${i + 1}`);
  const map = detected ? detected.map : { name: 0, price: 1, brand: -1, code: -1 };

  pendingImport = { rawRows: rows, headerRowIndex, headers, map, fileName };
  renderImportMappingModal();
}

function renderImportMappingModal() {
  const { headers, map } = pendingImport;
  const inv = {};
  for (const k in map) {
    if (map[k] >= 0) inv[map[k]] = k;
  }

  const fieldOpts = v => [['', 'نادیده گرفتن'], ['name', 'نام کالا'], ['price', 'قیمت'], ['brand', 'برند'], ['code', 'کد فنی']]
    .map(([val, l]) => `<option value="${val}" ${val === v ? 'selected' : ''}>${esc(l)}</option>`)
    .join('');

  showModal('نگاشت ستون‌های فایل', `
    <div class="map-grid">${headers.map((h, i) => `<label>${esc(h || 'ستون ' + (i + 1))}<select data-col="${i}">${fieldOpts(inv[i] || '')}</select></label>`).join('')}</div>
    <div class="modal-actions"><button class="primary-btn" id="buildPreviewBtn">پیش‌نمایش</button><button class="small-btn" id="cancelImportBtn">انصراف</button></div>
  `);

  $('cancelImportBtn').onclick = () => { pendingImport = null; closeModal(); };

  $('buildPreviewBtn').onclick = async () => {
    const newMap = { name: -1, price: -1, brand: -1, code: -1 };
    document.querySelectorAll('[data-col]').forEach(sel => {
      if (sel.value) newMap[sel.value] = Number(sel.dataset.col);
    });

    if (newMap.name < 0 || newMap.price < 0) return notify('ستون نام و قیمت اجباری است.');
    pendingImport.map = newMap;
    await computeImportRows();
    renderImportPreviewModal();
  };
}

async function computeImportRows() {
  const { rawRows, headerRowIndex, headers, map, fileName } = pendingImport;
  const existing = await all('products');
  const parsed = [];
  const existingMap = new Map();

  const identityKeys = p => {
    const keys = [];
    if (p.code) keys.push('c:' + norm(p.code));
    if (!keys.length && p.name) keys.push('n:' + norm(p.name));
    return keys;
  };

  for (const p of existing) {
    for (const k of identityKeys(p)) {
      if (!existingMap.has(k)) existingMap.set(k, p);
    }
  }

  let multiplier = 1;
  const hStr = norm(headers[map.price] || '');
  if (/میلیون/.test(hStr)) multiplier = 10000000;
  else if (/هزار/.test(hStr)) multiplier = 10000;
  else if (hStr.includes('تومان')) multiplier = 1;

  const sourceRows = rawRows.slice(headerRowIndex + 1);

  for (let i = 0; i < sourceRows.length; i++) {
    const row = sourceRows[i];
    const name = String(row[map.name] ?? '').trim();
    const price = Math.round(num(row[map.price]) * multiplier);

    if (!name || price <= 0) continue;

    const candidate = {
      name,
      price,
      brand: map.brand >= 0 ? String(row[map.brand] ?? '').trim() : '',
      code: map.code >= 0 ? String(row[map.code] ?? '').trim() : ''
    };

    parsed.push(candidate);
  }

  const result = [];
  for (const r of parsed) {
    let existingMatch = null;
    for (const k of identityKeys(r)) {
      const found = existingMap.get(k);
      if (found) {
        existingMatch = found;
        break;
      }
    }

    const status = !existingMatch ? 'new' : (Number(existingMatch.basePrice) !== r.price ? 'updated' : 'skip');
    result.push({ ...r, status, existingId: existingMatch ? existingMatch.id : null });
  }

  pendingImport.rows = result;
  pendingImport.fileName = fileName;
}

function renderImportPreviewModal() {
  const rows = pendingImport.rows;
  const counts = { new: 0, updated: 0, skip: 0 };
  rows.forEach(r => counts[r.status]++);

  showModal('پیش‌نمایش ورود اطلاعات', `
    <div class="import-summary"><span>جدید: ${fmt(counts.new)}</span><span>تغییر قیمت: ${fmt(counts.updated)}</span></div>
    <div style="overflow:auto;max-height:40vh">
      <table class="import-preview-table">
        <thead><tr><th>وضعیت</th><th>نام</th><th>قیمت (ریال)</th></tr></thead>
        <tbody>${rows.slice(0, 200).map(r => `<tr class="row-${r.status}"><td>${r.status}</td><td>${esc(r.name)}</td><td>${fmt(r.price)}</td></tr>`).join('')}</tbody>
      </table>
    </div>
    <div class="modal-actions"><button class="primary-btn" id="confirmImportBtn">تأیید و ثبت</button><button class="small-btn" id="cancelImportBtn2">انصراف</button></div>
  `);

  $('cancelImportBtn2').onclick = () => { pendingImport = null; closeModal(); };

  $('confirmImportBtn').onclick = async () => {
    const productsById = new Map((await all('products')).map(p => [p.id, p]));
    const productsToWrite = [];
    let added = 0;
    let updated = 0;

    for (const r of pendingImport.rows) {
      if (r.status === 'updated' && r.existingId) {
        const ex = productsById.get(r.existingId);
        if (ex) {
          productsToWrite.push({ ...ex, name: r.name, basePrice: r.price, brand: r.brand || ex.brand, code: r.code || ex.code });
          updated++;
        }
      } else if (r.status === 'new') {
        productsToWrite.push({
          id: uid(),
          name: r.name,
          altNames: [],
          brand: r.brand,
          cars: [],
          code: r.code,
          oem: '',
          barcode: '',
          basePrice: r.price,
          priceType: 'base',
          itemProfitPercent: '',
          source: 'Excel',
          createdAt: new Date().toISOString()
        });
        added++;
      }
    }

    await putMany('products', productsToWrite);
    pendingImport = null;
    closeModal();
    await refreshAll();
    notify(`ثبت شد: ${fmt(added)} جدید، ${fmt(updated)} به‌روزرسانی.`);
  };
}

if ($('importFile')) {
  $('importFile').onchange = async e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    try {
      let rows;

      if (/\.csv$|\.txt$/i.test(file.name)) {
        const text = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsText(file, 'UTF-8');
        });

        rows = text.split('\n').map(r => r.split(','));
      } else if (/\.xlsx$|\.xls$/i.test(file.name)) {
        notify('در حال آماده‌سازی فایل اکسل...');
        if (!window.XLSX) await loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
        if (!window.XLSX) throw new Error('کتابخانه اکسل لود نشد.');

        const buffer = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsArrayBuffer(file);
        });

        const workbook = window.XLSX.read(buffer, { type: 'array' });
        rows = window.XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '' });
      } else {
        throw new Error('فقط xlsx, csv پشتیبانی می‌شود.');
      }

      await buildImportPreview(rows, file.name);
    } catch (err) {
      notify('خطا در ورود: ' + err.message);
    } finally {
      e.target.value = '';
    }
  };
}

async function refreshAll() {
  await renderProducts(true);
  await renderRules();
  await renderHistory(true);
  await renderSources();
}

async function renderSources() {
  const sources = (await all('sources')).sort((a, b) => (a.name || '').localeCompare(b.name || 'fa'));
  const list = $('sourceList');

  if (!list) return;

  list.innerHTML = sources.length
    ? sources.map(s => `<div class="list-row"><b>${esc(s.name)}</b><small>${esc(s.type || '')}</small></div>`).join('')
    : '<div class="empty">منبعی ثبت نشده است.</div>';
}

if ($('sourceForm')) {
  $('sourceForm').onsubmit = async e => {
    e.preventDefault();
    const name = $('sourceName').value.trim();
    const type = $('sourceType').value.trim();

    if (!name) return notify('نام منبع الزامی است.');
    await put('sources', { id: uid(), name, type, createdAt: new Date().toISOString() });

    e.target.reset();
    await renderSources();
    notify('منبع ثبت شد');
  };
}

async function init() {
  db = await openDB();
  if (!await get('settings', 'defaultProfit')) {
    await put('settings', { key: 'defaultProfit', value: 15 });
  }
  await refreshAll();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.getRegistrations().then(function (registrations) {
      for (let registration of registrations) {
        registration.unregister();
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('homeSearch');
  if (input) {
    input.addEventListener('input', debounce(async () => {
      await renderHomeSearchResults();
    }, 180));
  }

  renderHomeSearchResults();
});

init().catch(() => {
  notify('خطا در پایگاه داده.');
});

const sideMenu = $('sideMenu');
const menuShade = $('menuShade');
const menuToggle = $('menuToggle');
const menuClose = $('menuClose');

function closeMenu() {
  if (sideMenu) sideMenu.classList.remove('open');
  if (menuShade) menuShade.classList.remove('open');
  document.body.classList.remove('menu-open');
}

if (menuToggle) {
  menuToggle.onclick = () => {
    if (sideMenu) sideMenu.classList.toggle('open');
    if (menuShade) menuShade.classList.toggle('open');
    document.body.classList.toggle('menu-open');
  };
}

if (menuClose) {
  menuClose.onclick = closeMenu;
}

if (menuShade) {
  menuShade.onclick = closeMenu;
}

document.querySelectorAll('#sideMenu [data-goto]').forEach(btn => {
  btn.onclick = () => {
    const target = btn.dataset.goto;
    if (target === 'home') {
      document.body.classList.add('home-view');
      closeMenu();
      return;
    }

    document.body.classList.remove('home-view');

    if (target === 'products') {
      document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === 'products'));
      document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.id === 'products'));
    }

    if (target === 'rules') {
      document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === 'rules'));
      document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.id === 'rules'));
    }

    if (target === 'history') {
      document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === 'history'));
      document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.id === 'history'));
    }

    if (target === 'tools') {
      document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === 'tools'));
      document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.id === 'tools'));
    }

    closeMenu();
  };
});

document.querySelectorAll('.tab').forEach(b => {
  b.onclick = () => {
    const tab = b.dataset.tab;
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === tab));
    document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.id === tab));
  };
});

if ($('voiceBtn')) {
  $('voiceBtn').onclick = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      notify('دستیار صوتی پشتیبانی نمی‌شود.');
      return;
    }

    const rec = new SR();
    rec.lang = 'fa-IR';
    rec.interimResults = false;

    rec.onstart = () => notify('گوش می‌دهم...');
    rec.onresult = e => {
      const text = e.results[0][0].transcript.trim().toLowerCase();

      if (text.includes('صفحه اصلی') || text.includes('خانه')) {
        document.body.classList.add('home-view');
      } else if (text.includes('تنظیمات') || text.includes('ظاهر')) {
        if ($('settingsBtn')) $('settingsBtn').click();
      } else if (text.includes('قواعد') || text.includes('سود')) {
        if ($('sideMenu')) {
          const btn = [...document.querySelectorAll('#sideMenu [data-goto]')].find(el => el.dataset.goto === 'rules');
          if (btn) btn.click();
        }
      } else {
        const query = text;
        if ($('homeSearch')) {
          $('homeSearch').value = query;
          renderHomeSearchResults();
        }
      }
    };

    rec.start();
  };
}