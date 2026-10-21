'use strict';
/* =========================================================================
   یدک‌پرایس — منطق برنامه (نسخه موبایلی، آفلاین، مبتنی بر IndexedDB)
   بخش‌ها: ابزارهای کمکی · لایه پایگاه‌داده · موتور قیمت‌گذاری ·
           موتور جست‌وجو · رندر رابط کاربری · واردات فایل (با پیش‌نمایش) ·
           قواعد سود · تاریخچه · منابع · تنظیمات · پشتیبان‌گیری · PWA
   ========================================================================= */

/* ---------------------------- ابزارهای کمکی ---------------------------- */
const DB_NAME = 'YadakPriceMobile';
const DB_VERSION = 2;
const PAGE_SIZE = 40;

let db, toastTimer, installPrompt = null;
let productPage = 1, historyPage = 1;
let pendingImport = null;

const $ = id => document.getElementById(id);
const now = () => new Date().toLocaleString('fa-IR');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function norm(v) {
  return String(v ?? '')
    .toLowerCase()
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[ۀة]/g, 'ه')
    .replace(/ـ/g, '')
    .replace(/[\u200c\u200f\u200e]/g, ' ')
    .replace(/[.\-_/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function faNum(v) {
  return String(v ?? '')
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
}

/* اعداد قیمت داخل برنامه به ریال نگهداری می‌شوند. */
function num(v) {
  let s = faNum(v)
    .replace(/[٬,،\s]/g, '')
    .replace(/ریال|تومان/g, '')
    .replace(/٫/g, '.');

  // اگر نقطه جداکننده هزارگان باشد، آن را حذف می‌کنیم.
  if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  }

  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function fmt(v) {
  return Math.round(Number(v) || 0).toLocaleString('fa-IR');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

function splitList(v) {
  return String(v ?? '')
    .split(/[,،\n]/)
    .map(x => x.trim())
    .filter(Boolean);
}

function notify(s) {
  $('toast').textContent = s;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => $('toast').classList.remove('show'),
    3200
  );
}

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(
      new Error('بارگذاری کتابخانه ناموفق بود؛ به اینترنت نیاز است.')
    );
    document.head.appendChild(s);
  });
}

function levenshtein(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;

  const dp = Array.from(
    { length: a.length + 1 },
    (_, i) => [i, ...Array(b.length).fill(0)]
  );

  for (let j = 0; j <= b.length; j++) dp[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(
            dp[i - 1][j - 1],
            dp[i][j - 1],
            dp[i - 1][j]
          );
    }
  }

  return dp[a.length][b.length];
}

/* ------------------------------ لایه IndexedDB ------------------------------ */

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

      for (const [name, key] of [
        ['rules', 'id'],
        ['history', 'id'],
        ['settings', 'key'],
        ['sources', 'id']
      ]) {
        if (!d.objectStoreNames.contains(name)) {
          d.createObjectStore(name, { keyPath: key });
        }
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

async function audit(
  productId,
  productName,
  field,
  oldValue,
  newValue,
  actor
) {
  actor = actor || await setting('actor', 'کاربر');

  await put('history', {
    id: uid(),
    productId,
    productName,
    field,
    oldValue: String(oldValue ?? ''),
    newValue: String(newValue ?? ''),
    actor,
    at: new Date().toISOString(),
    displayAt: now()
  });
}

/* ---------------------------- موتور قیمت‌گذاری ---------------------------- */

// اولویت:
// ۱) قیمت نهایی بدون سود
// ۲) سود اختصاصی کالا
// ۳) قاعده گروهی دقیق‌تر
// ۴) سود پیش‌فرض

function isFinalPrice(p) {
  return p.priceType === 'final';
}

function matchedRule(p, rules) {
  const name = norm(p.name);
  const brand = norm(p.brand);

  const matches = rules.filter(r => {
    const termOk = !r.term || name.includes(norm(r.term));
    const brandOk = !r.brand || brand.includes(norm(r.brand));

    return (r.term || r.brand) && termOk && brandOk;
  });

  if (!matches.length) return null;

  matches.sort((a, b) =>
    (norm(b.term).length + norm(b.brand).length) -
    (norm(a.term).length + norm(a.brand).length)
  );

  return matches[0];
}

function profitInfo(p, rules, defaultProfit) {
  if (isFinalPrice(p)) {
    return {
      percent: 0,
      origin: 'final',
      label: 'قیمت نهایی · بدون سود اضافه'
    };
  }

  if (
    p.itemProfitPercent !== null &&
    p.itemProfitPercent !== undefined &&
    p.itemProfitPercent !== ''
  ) {
    return {
      percent: Number(p.itemProfitPercent),
      origin: 'item',
      label: `سود اختصاصی کالا ${fmt(p.itemProfitPercent)}٪`
    };
  }

  const rule = matchedRule(p, rules);

  if (rule) {
    return {
      percent: Number(rule.percent),
      origin: 'group',
      label: `قاعده گروهی (${[
        rule.term,
        rule.brand
      ].filter(Boolean).join(' · ')}) ${fmt(rule.percent)}٪`
    };
  }

  return {
    percent: Number(defaultProfit),
    origin: 'default',
    label: `سود پیش‌فرض ${fmt(defaultProfit)}٪`
  };
}

function sellPrice(p, rules, defaultProfit) {
  if (isFinalPrice(p)) return Number(p.basePrice) || 0;

  const raw = (Number(p.basePrice) || 0) *
    (1 + profitInfo(p, rules, defaultProfit).percent / 100);

  // قیمت فروش برحسب ریال گرد می‌شود.
  return Math.round(raw);
}

/* ------------------------------ موتور جست‌وجو ------------------------------
   اولویت تطبیق:
   0: کد فنی/OEM
   1: بارکد
   2: نام دقیق
   3: عبارت در نام
   4: نام و برند
   5: نام و خودرو
   6: نام جایگزین
   7: سایر فیلدها
   8: تطبیق تقریبی
----------------------------------------------------------------------------*/

function matchTier(p, qWords, qNorm) {
  const name = norm(p.name);
  const brand = norm(p.brand);
  const cars = norm((p.cars || []).join(' '));
  const code = norm(p.code);
  const oem = norm(p.oem);
  const barcode = norm(p.barcode);
  const alt = norm((p.altNames || []).join(' '));

  if (qNorm && (code === qNorm || oem === qNorm) && (code || oem)) {
    return 0;
  }

  if (qNorm && barcode && barcode === qNorm) return 1;
  if (qNorm && name === qNorm) return 2;

  const inName = w => name.includes(w);
  const inNameBrand = w => name.includes(w) || brand.includes(w);
  const inNameCar = w => name.includes(w) || cars.includes(w);
  const inAlt = w => alt.includes(w);

  const inAny = w =>
    name.includes(w) ||
    brand.includes(w) ||
    cars.includes(w) ||
    code.includes(w) ||
    oem.includes(w) ||
    barcode.includes(w);

  if (qWords.every(inName)) return 3;
  if (qWords.every(inNameBrand)) return 4;
  if (qWords.every(inNameCar)) return 5;
  if (qWords.every(inAlt)) return 6;
  if (qWords.every(inAny)) return 7;

  return null;
}

function searchProducts(products, query) {
  const qNorm = norm(query);

  if (!qNorm) {
    return products.slice().sort(
      (a, b) => norm(a.name).localeCompare(norm(b.name), 'fa')
    );
  }

  const qWords = qNorm.split(' ').filter(Boolean);
  const scored = [];
  const unmatched = [];

  for (const p of products) {
    const tier = matchTier(p, qWords, qNorm);

    if (tier !== null) scored.push({ p, tier });
    else unmatched.push(p);
  }

  if (
    qWords.length === 1 &&
    qWords[0].length >= 3 &&
    qWords[0].length <= 20
  ) {
    const maxDist = qWords[0].length <= 5 ? 1 : 2;

    for (const p of unmatched) {
      const tokens = norm(p.name).split(' ');
      const hit = tokens.some(
        t => t.length >= 3 &&
          levenshtein(t, qWords[0], maxDist) <= maxDist
      );

      if (hit) scored.push({ p, tier: 8 });
    }
  }

  scored.sort(
    (a, b) => a.tier - b.tier ||
      norm(a.p.name).localeCompare(norm(b.p.name), 'fa')
  );

  return scored.map(x => x.p);
}

/* -------------------------------- رندر کالاها -------------------------------- */

async function getFiltered() {
  const products = await all('products');
  let rows = searchProducts(products, $('search').value);

  const brand = $('filterBrand').value;
  const source = $('filterSource').value;
  const ptype = $('filterPriceType').value;
  const minP = num($('filterMinPrice').value);
  const maxP = num($('filterMaxPrice').value);
  const hasCode = $('filterHasCode').checked;

  if (brand) rows = rows.filter(p => p.brand === brand);
  if (source) rows = rows.filter(p => p.source === source);
  if (ptype) rows = rows.filter(p => (p.priceType || 'base') === ptype);
  if (hasCode) rows = rows.filter(p => p.code);

  const rules = await all('rules');
  const defaultProfit = await setting('defaultProfit', 15);

  let withPrice = rows.map(p => ({
    p,
    sell: sellPrice(p, rules, defaultProfit),
    info: profitInfo(p, rules, defaultProfit)
  }));

  if ($('filterMinPrice').value) {
    withPrice = withPrice.filter(x => x.sell >= minP);
  }

  if ($('filterMaxPrice').value) {
    withPrice = withPrice.filter(x => x.sell <= maxP);
  }

  return withPrice;
}

async function populateFilterOptions() {
  const products = await all('products');

  const brands = [...new Set(
    products.map(p => p.brand).filter(Boolean)
  )].sort((a, b) => norm(a).localeCompare(norm(b), 'fa'));

  const sources = [...new Set(
    products.map(p => p.source).filter(Boolean)
  )].sort((a, b) => norm(a).localeCompare(norm(b), 'fa'));

  const fillSelect = (sel, items, current) => {
    sel.innerHTML = sel.querySelector('option').outerHTML +
      items.map(v =>
        `<option ${v === current ? 'selected' : ''}>${esc(v)}</option>`
      ).join('');
  };

  fillSelect($('filterBrand'), brands, $('filterBrand').value);
  fillSelect($('filterSource'), sources, $('filterSource').value);
}

async function renderProducts(resetPage) {
  if (resetPage) productPage = 1;

  const rows = await getFiltered();
  $('countStat').textContent = `${fmt(rows.length)} کالا`;

  const visible = rows.slice(0, productPage * PAGE_SIZE);

  $('productList').innerHTML = visible.map(({ p, sell, info }) => `
    <article class="product-card">
      <div class="product-title">${esc(p.name)}</div>
      <div class="product-meta">
        ${p.brand ? `<span class="pill">برند: ${esc(p.brand)}</span>` : ''}
        ${(p.cars && p.cars.length)
          ? `<span class="pill">خودرو: ${esc(p.cars.join('، '))}</span>`
          : ''}
        ${p.code ? `<span class="pill">کد: ${esc(p.code)}</span>` : ''}
        ${p.oem ? `<span class="pill">OEM: ${esc(p.oem)}</span>` : ''}
        ${p.barcode ? `<span class="pill">بارکد: ${esc(p.barcode)}</span>` : ''}
        <span class="pill ${
          info.origin === 'final'
            ? 'final'
            : (info.origin === 'item' ? 'manual' : '')
        }">${esc(info.label)}</span>
      </div>
      <div class="price-row">
        <div>
          <div class="price">${fmt(sell)} <small>ریال</small></div>
          <div class="subprice">
            قیمت پایه: ${fmt(p.basePrice)} ·
            ${esc(p.priceType === 'final' ? 'قیمت نهایی' : 'قیمت پایه')}
          </div>
        </div>
        <span class="pill">${esc(p.source || 'ورود دستی')}</span>
      </div>
      <div class="card-actions">
        <button class="small-btn" data-edit="${p.id}">ویرایش</button>
        <button class="small-btn" data-hist="${p.id}">سابقه تغییر</button>
        <button class="small-btn" data-delete="${p.id}">حذف</button>
      </div>
    </article>
  `).join('');

  $('emptyProducts').classList.toggle('hidden', rows.length > 0);

  $('emptyProducts').textContent = $('search').value.trim()
    ? 'نتیجه‌ای پیدا نشد.'
    : 'هنوز کالایی ثبت نشده است. از «کالای جدید» یا بخش ورود اطلاعات شروع کن.';

  $('loadMoreBtn').classList.toggle('hidden', visible.length >= rows.length);

  $('productList').querySelectorAll('[data-edit]').forEach(
    b => b.onclick = () => editProduct(b.dataset.edit)
  );

  $('productList').querySelectorAll('[data-hist]').forEach(
    b => b.onclick = () => showProductHistory(b.dataset.hist)
  );

  $('productList').querySelectorAll('[data-delete]').forEach(
    b => b.onclick = () => deleteProduct(b.dataset.delete)
  );

  await populateFilterOptions();
}

$('loadMoreBtn').onclick = () => {
  productPage++;
  renderProducts(false);
};

/* -------------------------------- مودال و فرم کالا -------------------------------- */

function showModal(title, html) {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = html;
  $('modalBackdrop').classList.remove('hidden');
}

function closeModal() {
  $('modalBackdrop').classList.add('hidden');
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
    source: 'ورود دستی'
  };

  showModal(id ? 'ویرایش کالا' : 'ثبت کالای جدید', `
    <form id="productForm" class="modal-form">
      <label>نام کالا *
        <input name="name" required value="${esc(p.name)}">
      </label>

      <label>نام‌های جایگزین (با کاما جدا کن)
        <input name="altNames" value="${esc((p.altNames || []).join('، '))}">
      </label>

      <div class="two">
        <label>برند
          <input name="brand" value="${esc(p.brand)}">
        </label>
        <label>خودرو/مدل‌های سازگار (با کاما)
          <input name="cars" value="${esc((p.cars || []).join('، '))}">
        </label>
      </div>

      <div class="two">
        <label>کد فنی
          <input name="code" value="${esc(p.code)}">
        </label>
        <label>کد OEM
          <input name="oem" value="${esc(p.oem)}">
        </label>
      </div>

      <div class="two">
        <label>بارکد
          <input name="barcode" value="${esc(p.barcode)}">
        </label>
        <label>قیمت پایه (ریال) *
          <input name="basePrice" inputmode="decimal" required value="${esc(p.basePrice)}">
        </label>
      </div>

      <div class="two">
        <label>نوع قیمت
          <select name="priceType">
            <option value="base" ${p.priceType !== 'final' ? 'selected' : ''}>
              قیمت پایه (سود اعمال شود)
            </option>
            <option value="final" ${p.priceType === 'final' ? 'selected' : ''}>
              قیمت نهایی (سود اضافه نشود)
            </option>
          </select>
        </label>

        <label>سود اختصاصی این کالا (٪، اختیاری)
          <input name="itemProfitPercent" type="number" min="0" max="500"
            step="0.1" value="${esc(p.itemProfitPercent ?? '')}"
            placeholder="خالی = استفاده از قاعده گروهی/پیش‌فرض">
        </label>
      </div>

      <label>منبع قیمت
        <input name="source" value="${esc(p.source || 'ورود دستی')}">
      </label>

      <div class="modal-actions">
        <button class="primary" type="submit">ذخیره کالا</button>
        <button class="ghost" type="button" id="cancelProduct">انصراف</button>
      </div>
    </form>
  `);

  $('cancelProduct').onclick = closeModal;

  $('productForm').onsubmit = async e => {
    e.preventDefault();

    const f = new FormData(e.target);

    const next = {
      ...p,
      name: String(f.get('name')).trim(),
      altNames: splitList(f.get('altNames')),
      brand: String(f.get('brand')).trim(),
      cars: splitList(f.get('cars')),
      code: String(f.get('code')).trim(),
      oem: String(f.get('oem')).trim(),
      barcode: String(f.get('barcode')).trim(),
      basePrice: num(f.get('basePrice')),
      priceType: f.get('priceType'),
      itemProfitPercent: f.get('itemProfitPercent') === ''
        ? ''
        : Number(f.get('itemProfitPercent')),
      source: String(f.get('source')).trim() || 'ورود دستی',
      updatedAt: new Date().toISOString()
    };

    if (!next.name || next.basePrice <= 0) {
      notify('نام کالا و قیمت پایه معتبر لازم است.');
      return;
    }

    await put('products', next);

    if (id) {
      for (const k of [
        'name',
        'brand',
        'code',
        'oem',
        'barcode',
        'basePrice',
        'priceType',
        'itemProfitPercent'
      ]) {
        const before = p[k] ?? '';
        const after = next[k] ?? '';

        if (String(before) !== String(after)) {
          await audit(id, next.name, fieldLabel(k), before, after);
        }
      }
    } else {
      await audit(
        next.id,
        next.name,
        'ثبت کالا',
        '',
        `${next.basePrice} ریال`
      );
    }

    closeModal();
    await renderProducts(true);
    notify('کالا ذخیره شد.');
  };
}

function fieldLabel(k) {
  return {
    name: 'نام کالا',
    brand: 'برند',
    code: 'کد فنی',
    oem: 'کد OEM',
    barcode: 'بارکد',
    basePrice: 'قیمت پایه',
    priceType: 'نوع قیمت',
    itemProfitPercent: 'سود اختصاصی کالا'
  }[k] || k;
}

async function deleteProduct(id) {
  const p = await get('products', id);

  if (
    !p ||
    !confirm(`کالای «${p.name}» حذف شود؟ سابقه تغییرات آن در تاریخچه باقی می‌ماند.`)
  ) return;

  await audit(id, p.name, 'حذف کالا', 'موجود', 'حذف شد');
  await del('products', id);
  await renderProducts(true);
  notify('کالا حذف شد؛ سابقه در تاریخچه باقی ماند.');
}

async function showProductHistory(id) {
  const h = (await all('history'))
    .filter(x => x.productId === id)
    .sort((a, b) => b.at.localeCompare(a.at));

  showModal(
    'سابقه تغییرات کالا',
    h.length
      ? `<div class="stack">${h.map(x => `
          <div class="list-row">
            <b>${esc(x.field)}</b>
            <small>${esc(x.displayAt || x.at)} · ${esc(x.actor || 'کاربر')}</small>
            <div>${esc(x.oldValue || '—')} ← ${esc(x.newValue || '—')}</div>
          </div>
        `).join('')}</div>`
      : '<div class="empty">برای این کالا سابقه‌ای ثبت نشده است.</div>'
  );
}

/* -------------------------------- قواعد سود گروهی -------------------------------- */

async function renderRules() {
  const rs = (await all('rules')).sort(
    (a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')
  );

  $('ruleList').innerHTML = rs.map(r => `
    <div class="list-row">
      <b>${esc(r.term || 'همه کالاها')} ${r.brand ? '· ' + esc(r.brand) : ''}</b>
      <small>سود ${fmt(r.percent)}٪ · ${esc(r.createdDisplay || '')}</small>
      <div class="card-actions">
        <button class="small-btn" data-rdel="${r.id}">حذف قاعده</button>
      </div>
    </div>
  `).join('') ||
    '<div class="empty">قاعده‌ای ثبت نشده؛ سود پیش‌فرض یا سود اختصاصی هر کالا اعمال می‌شود.</div>';

  $('ruleList').querySelectorAll('[data-rdel]').forEach(b => {
    b.onclick = async () => {
      const r = await get('rules', b.dataset.rdel);

      await del('rules', b.dataset.rdel);
      await audit(
        '',
        `قاعده ${r.term || ''}`,
        'حذف قاعده گروهی',
        `${r.percent}%`,
        'حذف شد'
      );

      await renderRules();
      await renderProducts(true);
      notify('قاعده حذف شد');
    };
  });
}

$('ruleForm').onsubmit = async e => {
  e.preventDefault();

  const term = $('ruleTerm').value.trim();
  const brand = $('ruleBrand').value.trim();
  const percent = Number($('rulePercent').value);

  if (!term && !brand) {
    notify('عبارت نام کالا یا برند را وارد کن.');
    return;
  }

  if (!Number.isFinite(percent) || percent < 0 || percent > 500) {
    notify('درصد سود معتبر نیست.');
    return;
  }

  const rule = {
    id: uid(),
    term,
    brand,
    percent,
    createdAt: new Date().toISOString(),
    createdDisplay: now()
  };

  await put('rules', rule);

  const ps = await all('products');
  let changed = 0;

  for (const p of ps) {
    if (isFinalPrice(p)) continue;

    if (
      p.itemProfitPercent !== null &&
      p.itemProfitPercent !== undefined &&
      p.itemProfitPercent !== ''
    ) continue;

    const nameOk = !term || norm(p.name).includes(norm(term));
    const brandOk = !brand || norm(p.brand).includes(norm(brand));

    if (nameOk && brandOk) changed++;
  }

  await audit(
    '',
    `${term} ${brand}`.trim(),
    'ساخت قاعده سود گروهی',
    '',
    `${percent}% · حدود ${changed} کالای منطبق`
  );

  e.target.reset();
  $('rulePercent').value = 10;

  await renderRules();
  await renderProducts(true);

  notify(`قاعده ثبت شد؛ حدود ${fmt(changed)} کالا منطبق است.`);
};

/* -------------------------------- تاریخچه -------------------------------- */

async function renderHistory(resetPage) {
  if (resetPage) historyPage = 1;

  let hs = (await all('history')).sort(
    (a, b) => b.at.localeCompare(a.at)
  );

  const q = norm($('historySearch').value);

  if (q) {
    hs = hs.filter(h =>
      norm([
        h.productName,
        h.field,
        h.actor,
        h.oldValue,
        h.newValue
      ].join(' ')).includes(q)
    );
  }

  const visible = hs.slice(0, historyPage * 60);

  $('historyList').innerHTML = visible.map(h => `
    <div class="list-row">
      <b>${esc(h.productName || 'تغییرات سیستم')} · ${esc(h.field)}</b>
      <small>${esc(h.displayAt || h.at)} · ${esc(h.actor || 'کاربر')}</small>
      <div>${esc(h.oldValue || '—')} ← ${esc(h.newValue || '—')}</div>
    </div>
  `).join('') || '<div class="empty">هنوز تغییری ثبت نشده است.</div>';

  $('historyMoreBtn').classList.toggle('hidden', visible.length >= hs.length);
}

$('historyMoreBtn').onclick = () => {
  historyPage++;
  renderHistory(false);
};

$('historySearch').oninput = () => renderHistory(true);

$('clearHistory').onclick = async () => {
  if (confirm('تمام تاریخچه پاک شود؟ این کار قابل برگشت نیست.')) {
    await clearStore('history');
    await renderHistory(true);
    notify('تاریخچه پاک شد');
  }
};

/* -------------------------------- منابع قیمت -------------------------------- */

async function renderSources() {
  const ss = (await all('sources')).sort(
    (a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')
  );

  $('sourceList').innerHTML = ss.map(s => `
    <div class="list-row">
      <b>${esc(s.name)}</b>
      <small>
        ${esc(s.type || '')} · ${esc(s.createdDisplay || '')}
        ${s.fileName ? ' · فایل: ' + esc(s.fileName) : ''}
      </small>
      ${s.newCount !== undefined
        ? `<small>
            جدید: ${fmt(s.newCount)} ·
            به‌روزشده: ${fmt(s.updatedCount)} ·
            بدون تغییر/رد‌شده: ${fmt(s.skippedCount)} ·
            خطا: ${fmt(s.errorCount)}
          </small>`
        : ''}
      <button class="small-btn" data-sdel="${s.id}">حذف رکورد منبع</button>
    </div>
  `).join('') || '<small>منبعی ثبت نشده است.</small>';

  $('sourceList').querySelectorAll('[data-sdel]').forEach(b => {
    b.onclick = async () => {
      await del('sources', b.dataset.sdel);
      renderSources();
    };
  });
}

$('sourceForm').onsubmit = async e => {
  e.preventDefault();

  const name = $('sourceName').value.trim();
  const type = $('sourceType').value.trim() || 'دستی';

  if (!name) return;

  await put('sources', {
    id: uid(),
    name,
    type,
    createdAt: new Date().toISOString(),
    createdDisplay: now()
  });

  e.target.reset();
  await renderSources();
  notify('منبع ثبت شد');
};

/* ------------------------- تنظیمات ظاهر و خوانایی ------------------------- */

function applyAppearance() {
  const appearance = {
    theme: localStorage.getItem('yadak_theme') || 'system',
    fontSize: localStorage.getItem('yadak_font_size') || 'normal',
    fontFamily: localStorage.getItem('yadak_font_family') || 'system',
    color: localStorage.getItem('yadak_color') || 'blue',
    density: localStorage.getItem('yadak_density') || 'comfortable'
  };

  const root = document.documentElement;

  root.dataset.theme = appearance.theme;
  root.dataset.fontSize = appearance.fontSize;
  root.dataset.fontFamily = appearance.fontFamily;
  root.dataset.color = appearance.color;
  root.dataset.density = appearance.density;

  const metaTheme = document.querySelector('meta[name="theme-color"]');

  if (metaTheme) {
    metaTheme.content = appearance.theme === 'dark'
      ? '#0f172a'
      : '#2563eb';
  }
}

applyAppearance();

const appearanceButton = document.getElementById('appearanceBtn');

if (appearanceButton) {
  appearanceButton.onclick = () => {
    const get = (key, fallback) =>
      localStorage.getItem(key) || fallback;

    showModal('تنظیمات ظاهر و خوانایی', `
      <form id="appearanceForm" class="modal-form">
        <label>تم برنامه
          <select name="theme">
            <option value="system" ${get('yadak_theme', 'system') === 'system' ? 'selected' : ''}>هماهنگ با گوشی</option>
            <option value="light" ${get('yadak_theme', 'system') === 'light' ? 'selected' : ''}>روشن</option>
            <option value="dark" ${get('yadak_theme', 'system') === 'dark' ? 'selected' : ''}>تاریک</option>
          </select>
        </label>

        <label>اندازه نوشته‌ها
          <select name="fontSize">
            <option value="small" ${get('yadak_font_size', 'normal') === 'small' ? 'selected' : ''}>کوچک</option>
            <option value="normal" ${get('yadak_font_size', 'normal') === 'normal' ? 'selected' : ''}>متوسط</option>
            <option value="large" ${get('yadak_font_size', 'normal') === 'large' ? 'selected' : ''}>بزرگ</option>
            <option value="xlarge" ${get('yadak_font_size', 'normal') === 'xlarge' ? 'selected' : ''}>خیلی بزرگ</option>
          </select>
        </label>

        <label>نوع فونت
          <select name="fontFamily">
            <option value="system" ${get('yadak_font_family', 'system') === 'system' ? 'selected' : ''}>پیش‌فرض دستگاه</option>
            <option value="vazir" ${get('yadak_font_family', 'system') === 'vazir' ? 'selected' : ''}>Vazirmatn (اگر نصب باشد)</option>
            <option value="tahoma" ${get('yadak_font_family', 'system') === 'tahoma' ? 'selected' : ''}>Tahoma</option>
            <option value="arial" ${get('yadak_font_family', 'system') === 'arial' ? 'selected' : ''}>Arial</option>
          </select>
        </label>

        <label>رنگ اصلی برنامه
          <select name="color">
            <option value="blue" ${get('yadak_color', 'blue') === 'blue' ? 'selected' : ''}>آبی</option>
            <option value="green" ${get('yadak_color', 'blue') === 'green' ? 'selected' : ''}>سبز</option>
            <option value="purple" ${get('yadak_color', 'blue') === 'purple' ? 'selected' : ''}>بنفش</option>
            <option value="orange" ${get('yadak_color', 'blue') === 'orange' ? 'selected' : ''}>نارنجی</option>
          </select>
        </label>

        <label>نمایش سطر کالاها
          <select name="density">
            <option value="comfortable" ${get('yadak_density', 'comfortable') === 'comfortable' ? 'selected' : ''}>معمولی</option>
            <option value="spacious" ${get('yadak_density', 'comfortable') === 'spacious' ? 'selected' : ''}>درشت و خوانا</option>
            <option value="compact" ${get('yadak_density', 'comfortable') === 'compact' ? 'selected' : ''}>فشرده</option>
          </select>
        </label>

        <div class="modal-actions">
          <button class="primary" type="submit">ذخیره تنظیمات</button>
          <button class="ghost" type="button" id="cancelAppearance">انصراف</button>
        </div>
      </form>
    `);

    document.getElementById('cancelAppearance').onclick = closeModal;

    document.getElementById('appearanceForm').onsubmit = event => {
      event.preventDefault();

      const form = new FormData(event.target);

      localStorage.setItem('yadak_theme', String(form.get('theme')));
      localStorage.setItem('yadak_font_size', String(form.get('fontSize')));
      localStorage.setItem('yadak_font_family', String(form.get('fontFamily')));
      localStorage.setItem('yadak_color', String(form.get('color')));
      localStorage.setItem('yadak_density', String(form.get('density')));

      applyAppearance();
      closeModal();

      if (typeof notify === 'function') {
        notify('تنظیمات ظاهر ذخیره شد');
      }
    };
  };
}

/* -------------------------------- تنظیمات -------------------------------- */

$('settingsBtn').onclick = async () => {
  const def = await setting('defaultProfit', 15);
  const actor = await setting('actor', 'کاربر');
  const currency = await setting('currency', 'ریال');

  showModal('تنظیمات', `
    <form id="settingsForm" class="modal-form">
      <label>سود پیش‌فرض (%)
        <input name="profit" type="number" min="0" max="500" step="0.1" value="${esc(def)}">
      </label>

      <label>واحد پول
        <input name="currency" value="${esc(currency)}">
      </label>

      <label>نام کاربر برای ثبت تغییرات
        <input name="actor" value="${esc(actor)}">
      </label>

      <div class="modal-actions">
        <button class="primary">ذخیره تنظیمات</button>
        <button type="button" class="ghost" id="cancelSettings">انصراف</button>
      </div>
    </form>
  `);

  $('cancelSettings').onclick = closeModal;

  $('settingsForm').onsubmit = async e => {
    e.preventDefault();

    const f = new FormData(e.target);
    const profit = Number(f.get('profit'));
    const who = String(f.get('actor')).trim() || 'کاربر';
    const currencyV = String(f.get('currency')).trim() || 'ریال';

    if (profit < 0 || profit > 500) {
      notify('سود پیش‌فرض معتبر نیست');
      return;
    }

    await put('settings', { key: 'defaultProfit', value: profit });
    await put('settings', { key: 'actor', value: who });
    await put('settings', { key: 'currency', value: currencyV });
    await audit('', 'تنظیمات', 'سود پیش‌فرض', def, profit, who);

    closeModal();
    await renderProducts(true);
    notify('تنظیمات ذخیره شد');
  };
};

/* -------------------------------- خروجی CSV و پشتیبان‌گیری -------------------------------- */

function csvEscape(v) {
  const s = String(v ?? '');
  return '"' + s.replace(/"/g, '""') + '"';
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

$('exportCsv').onclick = async () => {
  const ps = await all('products');

  const header = [
    'نام کالا',
    'برند',
    'خودرو',
    'کد فنی',
    'OEM',
    'بارکد',
    'قیمت پایه',
    'نوع قیمت',
    'سود اختصاصی',
    'منبع'
  ];

  const lines = [
    header,
    ...ps.map(p => [
      p.name,
      p.brand,
      (p.cars || []).join('، '),
      p.code,
      p.oem,
      p.barcode,
      p.basePrice,
      p.priceType === 'final' ? 'قیمت نهایی' : 'قیمت پایه',
      p.itemProfitPercent ?? '',
      p.source
    ])
  ].map(row => row.map(csvEscape).join(','));

  download(
    'yadak-price-products.csv',
    '\ufeff' + lines.join('\r\n'),
    'text/csv;charset=utf-8'
  );

  notify('خروجی CSV آماده شد');
};

$('backupBtn').onclick = async () => {
  const data = {
    app: 'YadakPriceMobile',
    version: DB_VERSION,
    createdAt: new Date().toISOString(),
    products: await all('products'),
    rules: await all('rules'),
    history: await all('history'),
    settings: await all('settings'),
    sources: await all('sources')
  };

  download(
    `yadak-price-backup-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify(data, null, 2),
    'application/json'
  );

  notify('پشتیبان کامل ساخته شد');
};

$('restoreFile').onchange = async e => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const d = JSON.parse(await file.text());

    if (d.app !== 'YadakPriceMobile' || !Array.isArray(d.products)) {
      throw new Error('ساختار فایل پشتیبان معتبر نیست');
    }

    if (!confirm(
      'بازیابی، داده‌های فعلی را با محتوای پشتیبان جایگزین می‌کند. ادامه؟'
    )) return;

    for (const s of [
      'products',
      'rules',
      'history',
      'settings',
      'sources'
    ]) {
      await clearStore(s);

      for (const row of (d[s] || [])) {
        await put(s, row);
      }
    }

    await refreshAll();
    notify('پشتیبان بازیابی شد');
  } catch (err) {
    notify('خطا: ' + err.message);
  } finally {
    e.target.value = '';
  }
};

/* =========================================================================
   واردات فایل با پیش‌نمایش و تأیید
   Excel / CSV
   ========================================================================= */

function parseCSV(text) {
  const rows = [];
  let row = [], v = '', quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (c === '"' && quoted && text[i + 1] === '"') {
      v += '"';
      i++;
    } else if (c === '"') {
      quoted = !quoted;
    } else if ((c === ',' || c === ';' || c === '\t') && !quoted) {
      row.push(v);
      v = '';
    } else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++;

      row.push(v);

      if (row.some(x => x.trim())) rows.push(row);

      row = [];
      v = '';
    } else {
      v += c;
    }
  }

  row.push(v);

  if (row.some(x => x.trim())) rows.push(row);

  return rows;
}

const FIELD_ALIASES = {
  name: [
    'نام کالا',
    'شرح کالا',
    'نام محصول',
    'شرح محصول',
    'نام',
    'شرح',
    'product name',
    'description'
  ],
  price: [
    'فی فروش',
    'قیمت فروش',
    'قیمت نهایی',
    'قیمت مصرف کننده',
    'قیمت',
    'فی',
    'مبلغ',
    'price',
    'amount'
  ],
  brand: ['برند کالا', 'برند', 'سازنده', 'brand'],
  cars: ['مدل خودرو', 'نوع خودرو', 'خودرو', 'ماشین', 'car', 'model'],
  code: ['کد کالا', 'کد محصول', 'شناسه کالا', 'کد', 'product code', 'sku'],
  oem: ['oem', 'کد oem', 'کد اصلی'],
  barcode: ['بارکد', 'barcode'],
  priceType: ['نوع قیمت', 'price type']
};

function headerIndex(headers, choices) {
  return headers.findIndex(h =>
    choices.some(c =>
      norm(h) === norm(c) || norm(h).includes(norm(c))
    )
  );
}

function detectHeaderAndMapping(rows) {
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const h = rows[i].map(x => String(x ?? ''));
    const n = headerIndex(h, FIELD_ALIASES.name);
    const p = headerIndex(h, FIELD_ALIASES.price);

    if (n >= 0 && p >= 0) {
      const map = { name: n, price: p };

      for (const k of [
        'brand',
        'cars',
        'code',
        'oem',
        'barcode',
        'priceType'
      ]) {
        map[k] = headerIndex(h, FIELD_ALIASES[k]);
      }

      return { headerRowIndex: i, headers: h, map };
    }
  }

  return null;
}

async function buildImportPreview(rows, fileName) {
  const detected = detectHeaderAndMapping(rows);
  const headerRowIndex = detected ? detected.headerRowIndex : 0;

  const headers = detected
    ? detected.headers
    : (rows[0] || []).map((_, i) => `ستون ${i + 1}`);

  const map = detected
    ? detected.map
    : {
        name: -1,
        price: -1,
        brand: -1,
        cars: -1,
        code: -1,
        oem: -1,
        barcode: -1,
        priceType: -1
      };

  pendingImport = {
    rawRows: rows,
    headerRowIndex,
    headers,
    map,
    fileName
  };

  renderImportMappingModal();
}

function fieldOptionsHtml(selected) {
  const fields = [
    ['', 'نادیده گرفتن'],
    ['name', 'نام کالا'],
    ['price', 'قیمت'],
    ['brand', 'برند'],
    ['cars', 'خودرو/مدل'],
    ['code', 'کد فنی'],
    ['oem', 'کد OEM'],
    ['barcode', 'بارکد'],
    ['priceType', 'نوع قیمت']
  ];

  return fields.map(([v, l]) =>
    `<option value="${v}" ${v === selected ? 'selected' : ''}>${l}</option>`
  ).join('');
}

function renderImportMappingModal() {
  const { headers, map } = pendingImport;
  const inv = {};

  for (const k in map) {
    if (map[k] >= 0) inv[map[k]] = k;
  }

  showModal('نگاشت ستون‌های فایل', `
    <p>ستون هر فیلد فایل را مشخص کن؛ تشخیص خودکار از قبل انجام شده و قابل اصلاح است.</p>

    <div class="map-grid">
      ${headers.map((h, i) => `
        <label>
          ${esc(h || 'ستون ' + (i + 1))}
          <select data-col="${i}">
            ${fieldOptionsHtml(inv[i] || '')}
          </select>
        </label>
      `).join('')}
    </div>

    <div class="modal-actions">
      <button class="primary" id="buildPreviewBtn">پردازش و پیش‌نمایش</button>
      <button class="ghost" id="cancelImportBtn">انصراف</button>
    </div>
  `);

  $('cancelImportBtn').onclick = () => {
    pendingImport = null;
    closeModal();
  };

  $('buildPreviewBtn').onclick = async () => {
    const newMap = {
      name: -1,
      price: -1,
      brand: -1,
      cars: -1,
      code: -1,
      oem: -1,
      barcode: -1,
      priceType: -1
    };

    document.querySelectorAll('[data-col]').forEach(sel => {
      if (sel.value) {
        newMap[sel.value] = Number(sel.dataset.col);
      }
    });

    if (newMap.name < 0 || newMap.price < 0) {
      notify('ستون «نام کالا» و «قیمت» باید مشخص شوند.');
      return;
    }

    pendingImport.map = newMap;

    await computeImportRows();
    renderImportPreviewModal();
  };
}

/* ------------------------- اصلاحات واحد قیمت و تکراری‌ها ------------------------- */

/*
  قیمت داخلی برنامه ریال است.

  تبدیل بر اساس عنوان ستون قیمت:
  میلیون تومان = 10,000,000 ریال برای هر واحد درج‌شده
  هزار تومان   = 10,000 ریال برای هر واحد درج‌شده
  تومان        = 10 ریال برای هر تومان
  ریال یا واحد نامشخص = بدون تبدیل

  این تبدیل فقط برای ردیف‌های فایل ورودی اعمال می‌شود.
  قیمت‌های قدیمی دیتابیس به‌صورت خودکار تغییر نمی‌کنند.
*/

function priceMultiplierFromHeader(header) {
  const h = norm(header);

  if (
    /میلیون\s*تومان/.test(h) ||
    /تومان\s*میلیون/.test(h)
  ) {
    return 10000000;
  }

  if (
    /هزار\s*تومان/.test(h) ||
    /تومان\s*هزار/.test(h)
  ) {
    return 10000;
  }

  if (h.includes('تومان')) return 10;

  return 1;
}

function hasProductIdentifier(p) {
  return !!(
    String(p.code || '').trim() ||
    String(p.oem || '').trim() ||
    String(p.barcode || '').trim()
  );
}

/*
  تشخیص هویت کالا:
  - اگر کد فنی، OEM یا بارکد مشترک وجود داشته باشد، کالا یکی است.
  - اگر هر دو کالا شناسه داشته باشند ولی شناسه‌ای مشترک نباشد،
    فقط به خاطر نام مشابه آن‌ها را یکی فرض نمی‌کنیم.
  - اگر هیچ‌کدام شناسه نداشته باشند، نام و برند معیار هستند.
*/

function sameProductIdentity(a, b) {
  if (
    a.code &&
    b.code &&
    norm(a.code) === norm(b.code)
  ) return true;

  if (
    a.oem &&
    b.oem &&
    norm(a.oem) === norm(b.oem)
  ) return true;

  if (
    a.barcode &&
    b.barcode &&
    norm(a.barcode) === norm(b.barcode)
  ) return true;

  if (hasProductIdentifier(a) || hasProductIdentifier(b)) {
    return false;
  }

  return !!norm(a.name) &&
    norm(a.name) === norm(b.name) &&
    norm(a.brand || '') === norm(b.brand || '');
}

async function computeImportRows() {
  const {
    rawRows,
    headerRowIndex,
    headers,
    map,
    fileName
  } = pendingImport;

  const existing = await all('products');
  const parsed = [];
  const duplicateMap = new Map();
  const existingMap = new Map();

  const normKey = value => norm(String(value ?? '').trim());

  // کلیدهای هویتی؛ کد، OEM و بارکد با هم اشتباه گرفته نمی‌شوند.
  const identityKeys = p => {
    const keys = [];

    const code = normKey(p.code);
    const oem = normKey(p.oem);
    const barcode = normKey(p.barcode);

    if (code) keys.push('c:' + code);
    if (oem) keys.push('o:' + oem);
    if (barcode) keys.push('b:' + barcode);

    if (
      !keys.length &&
      normKey(p.name)
    ) {
      keys.push(
        'n:' + normKey(p.name) + '|' + normKey(p.brand)
      );
    }

    return keys;
  };

  const register = (store, item) => {
    for (const key of identityKeys(item)) {
      if (!store.has(key)) store.set(key, item);
    }
  };

  // فقط اولین کالای موجود برای هر کلید حفظ می‌شود.
  for (const product of existing) {
    register(existingMap, product);
  }

  const multiplier = priceMultiplierFromHeader(
    headers[map.price] || ''
  );

  const sourceRows = rawRows.slice(headerRowIndex + 1);

  for (let i = 0; i < sourceRows.length; i++) {
    const row = sourceRows[i];

    const name = String(row[map.name] ?? '').trim();
    const rawPrice = num(row[map.price]);
    const price = Math.round(rawPrice * multiplier);

    const brand = map.brand >= 0
      ? String(row[map.brand] ?? '').trim()
      : '';

    const cars = map.cars >= 0
      ? splitList(row[map.cars])
      : [];

    const code = map.code >= 0
      ? String(row[map.code] ?? '').trim()
      : '';

    const oem = map.oem >= 0
      ? String(row[map.oem] ?? '').trim()
      : '';

    const barcode = map.barcode >= 0
      ? String(row[map.barcode] ?? '').trim()
      : '';

    const typeRaw = map.priceType >= 0
      ? norm(row[map.priceType])
      : '';

    const priceType = (
      typeRaw.includes('نهایی') ||
      norm(brand).includes('ایساکو') ||
      norm(name).includes('ایساکو')
    ) ? 'final' : 'base';

    if (!name && !rawPrice) continue;

    const candidate = {
      name,
      price,
      brand,
      cars,
      code,
      oem,
      barcode,
      priceType
    };

    if (!name || rawPrice <= 0 || price <= 0) {
      parsed.push({
        ...candidate,
        status: 'error',
        reason: 'نام یا قیمت نامعتبر',
        existingId: null,
        _active: true,
        _valid: false
      });
    } else {
      const keys = identityKeys(candidate);

      let duplicate = null;

      for (const key of keys) {
        const found = duplicateMap.get(key);

        if (found && found._active) {
          duplicate = found;
          break;
        }
      }

      // آخرین ردیف معتبر جایگزین تکراری قبلی می‌شود.
      if (duplicate) {
        duplicate._active = false;

        for (const key of identityKeys(duplicate)) {
          if (duplicateMap.get(key) === duplicate) {
            duplicateMap.delete(key);
          }
        }
      }

      const entry = {
        ...candidate,
        _active: true,
        _valid: true
      };

      parsed.push(entry);

      for (const key of keys) {
        duplicateMap.set(key, entry);
      }
    }

    // هر 500 ردیف به رابط کاربری فرصت اجرا می‌دهیم.
    if (i > 0 && i % 500 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  const activeRows = parsed.filter(r => r._active);
  const result = [];

  for (let i = 0; i < activeRows.length; i++) {
    const r = activeRows[i];

    if (!r._valid) {
      const {
        _valid,
        _active,
        ...clean
      } = r;

      result.push(clean);
      continue;
    }

    let existingMatch = null;

    for (const key of identityKeys(r)) {
      const found = existingMap.get(key);

      if (found) {
        existingMatch = found;
        break;
      }
    }

    const status = !existingMatch
      ? 'new'
      : (
          Number(existingMatch.basePrice) !== r.price
            ? 'updated'
            : 'skip'
        );

    let reason;

    if (status === 'new') {
      reason = 'کالای جدید';
    } else if (status === 'updated') {
      reason = `قیمت ${fmt(existingMatch.basePrice)} ← ${fmt(r.price)}`;
    } else {
      reason = 'بدون تغییر قیمت';
    }

    const {
      _valid,
      _active,
      ...clean
    } = r;

    result.push({
      ...clean,
      status,
      reason,
      existingId: existingMatch ? existingMatch.id : null
    });

    if (i > 0 && i % 500 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  pendingImport.rows = result;
  pendingImport.fileName = fileName;
}
 
function renderImportPreviewModal() {
  const rows = pendingImport.rows;

  const counts = {
    new: 0,
    updated: 0,
    skip: 0,
    error: 0
  };

  rows.forEach(r => counts[r.status]++);

  const shown = rows.slice(0, 200);

  showModal('پیش‌نمایش ورود اطلاعات', `
    <div class="import-summary">
      <span>جدید: ${fmt(counts.new)}</span>
      <span>تغییر قیمت: ${fmt(counts.updated)}</span>
      <span>بدون تغییر: ${fmt(counts.skip)}</span>
      <span>نامعتبر: ${fmt(counts.error)}</span>
      <span>مجموع: ${fmt(rows.length)}</span>
    </div>

    ${rows.length > 200
      ? '<p>فقط ۲۰۰ ردیف نخست نمایش داده می‌شود؛ شمارش‌ها مربوط به کل فایل است.</p>'
      : ''}

    <div style="overflow:auto;max-height:40vh">
      <table class="import-preview-table">
        <thead>
          <tr>
            <th>وضعیت</th>
            <th>نام</th>
            <th>قیمت (ریال)</th>
            <th>برند</th>
            <th>توضیح</th>
          </tr>
        </thead>

        <tbody>
          ${shown.map(r => `
            <tr class="row-${r.status}">
              <td>${{
                new: 'جدید',
                updated: 'تغییر قیمت',
                skip: 'بدون تغییر',
                error: 'نامعتبر'
              }[r.status]}</td>

              <td>${esc(r.name)}</td>
              <td>${fmt(r.price)}</td>
              <td>${esc(r.brand)}</td>
              <td>${esc(r.reason)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <div class="modal-actions">
      <button class="primary" id="confirmImportBtn">
        تأیید و ثبت نهایی (${fmt(counts.new + counts.updated)} مورد)
      </button>

      <button class="ghost" id="backMapBtn">
        بازگشت به نگاشت ستون‌ها
      </button>

      <button class="ghost" id="cancelImportBtn2">
        انصراف (چیزی ثبت نمی‌شود)
      </button>
    </div>
  `);

  $('cancelImportBtn2').onclick = () => {
    pendingImport = null;
    closeModal();
  };

  $('backMapBtn').onclick = () => renderImportMappingModal();
  $('confirmImportBtn').onclick = commitImport;
}

async function commitImport() {
  const { rows, fileName } = pendingImport;

  let added = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const r of rows) {
    if (r.status === 'error') {
      errors++;
      continue;
    }

    if (r.status === 'skip') {
      skipped++;
      continue;
    }

    if (r.status === 'updated' && r.existingId) {
      const existing = await get('products', r.existingId);

      if (!existing) {
        errors++;
        continue;
      }

      const before = existing.basePrice;

      const next = {
        ...existing,
        name: r.name,
        brand: r.brand || existing.brand,
        cars: r.cars.length ? r.cars : existing.cars,
        code: r.code || existing.code,
        oem: r.oem || existing.oem,
        barcode: r.barcode || existing.barcode,
        basePrice: r.price,
        priceType: r.priceType,
        source: fileName,
        updatedAt: new Date().toISOString()
      };

      await put('products', next);

      await audit(
        next.id,
        next.name,
        'قیمت از فایل',
        before,
        r.price
      );

      updated++;
    } else if (r.status === 'new') {
      const p = {
        id: uid(),
        name: r.name,
        altNames: [],
        brand: r.brand,
        cars: r.cars,
        code: r.code,
        oem: r.oem,
        barcode: r.barcode,
        basePrice: r.price,
        priceType: r.priceType,
        itemProfitPercent: '',
        source: fileName,
        updatedAt: new Date().toISOString()
      };

      await put('products', p);

      await audit(
        p.id,
        p.name,
        'ورود از فایل',
        '',
        r.price
      );

      added++;
    }
  }

  await put('sources', {
    id: uid(),
    name: fileName,
    type: 'ورود فایل',
    fileName,
    createdAt: new Date().toISOString(),
    createdDisplay: now(),
    newCount: added,
    updatedCount: updated,
    skippedCount: skipped,
    errorCount: errors
  });

  pendingImport = null;
  closeModal();

  await refreshAll();

  notify(
    `ورود تمام شد: ${fmt(added)} جدید، ` +
    `${fmt(updated)} به‌روزرسانی، ` +
    `${fmt(skipped)} بدون تغییر، ` +
    `${fmt(errors)} نامعتبر.`
  );
}

$('importFile').onchange = async e => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    let rows;

    if (/\.csv$|\.txt$/i.test(file.name)) {
      rows = parseCSV(await file.text());
    } else if (/\.xlsx$|\.xls$/i.test(file.name)) {
      if (!window.XLSX) {
        await loadScript(
          'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'
        );
      }

      const ab = await file.arrayBuffer();
      const wb = XLSX.read(ab, { type: 'array' });

      rows = XLSX.utils.sheet_to_json(
        wb.Sheets[wb.SheetNames[0]],
        { header: 1, defval: '' }
      );
    } else {
      throw new Error('فرمت فایل پشتیبانی نمی‌شود');
    }

    await buildImportPreview(rows, file.name);
  } catch (err) {
    notify('خطا در ورود: ' + err.message);
  } finally {
    e.target.value = '';
  }
};

/* -------------------------------- رویدادهای عمومی رابط -------------------------------- */

let searchDebounceTimer;

function debouncedRenderProducts() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(
    () => renderProducts(true),
    150
  );
}

$('search').oninput = debouncedRenderProducts;

$('clearSearch').onclick = () => {
  $('search').value = '';
  renderProducts(true);
};

[
  'filterBrand',
  'filterSource',
  'filterPriceType',
  'filterMinPrice',
  'filterMaxPrice',
  'filterHasCode'
].forEach(id => {
  $(id).addEventListener('input', () => renderProducts(true));
  $(id).addEventListener('change', () => renderProducts(true));
});

$('clearFilters').onclick = () => {
  $('filterBrand').value = '';
  $('filterSource').value = '';
  $('filterPriceType').value = '';
  $('filterMinPrice').value = '';
  $('filterMaxPrice').value = '';
  $('filterHasCode').checked = false;

  renderProducts(true);
};

$('addBtn').onclick = () => editProduct(null);
$('closeModal').onclick = closeModal;

$('modalBackdrop').onclick = e => {
  if (e.target === $('modalBackdrop')) closeModal();
};

document.querySelectorAll('.tab').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => {
      x.classList.toggle('active', x === b);
    });

    document.querySelectorAll('.pane').forEach(p => {
      p.classList.toggle('active', p.id === b.dataset.tab);
    });

    if (b.dataset.tab === 'history') renderHistory(true);
    if (b.dataset.tab === 'rules') renderRules();
    if (b.dataset.tab === 'tools') renderSources();
  };
});

$('voiceBtn').onclick = () => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SR) {
    notify('جست‌وجوی صوتی در این مرورگر پشتیبانی نمی‌شود.');
    return;
  }

  const rec = new SR();
  rec.lang = 'fa-IR';
  rec.interimResults = false;

  rec.onstart = () => notify('گوش می‌دهم؛ نام قطعه را بگو…');

  rec.onresult = e => {
    $('search').value = e.results[0][0].transcript;
    renderProducts(true);
  };

  rec.onerror = () => {
    notify('دسترسی میکروفون ممکن نیست یا گفتار تشخیص داده نشد.');
  };

  rec.start();
};

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  $('installBtn').classList.remove('hidden');
});

$('installBtn').onclick = async () => {
  if (installPrompt) {
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    $('installBtn').classList.add('hidden');
  } else {
    notify(
      'از منوی مرورگر گزینه Add to Home Screen / افزودن به صفحه اصلی را بزن.'
    );
  }
};

/* -------------------------------- بارگذاری اولیه کاتالوگ -------------------------------- */

function bulkPutProducts(rows) {
  return new Promise((resolve, reject) => {
    const t = db.transaction('products', 'readwrite');
    const store = t.objectStore('products');

    for (const r of rows) store.put(r);

    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

async function seedIfEmpty() {
  const countReq = await new Promise((res, rej) => {
    const r = db.transaction('products').objectStore('products').count();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

  if (countReq > 0) return;

  try {
    const resp = await fetch('./seed-data.json');

    if (!resp.ok) return;

    const seed = await resp.json();

    if (!Array.isArray(seed) || !seed.length) return;

    await bulkPutProducts(seed);

    await put('sources', {
      id: uid(),
      name: 'list_asli14050714.xlsx (کاتالوگ اصلی)',
      type: 'بارگذاری اولیه',
      fileName: 'list_asli14050714.xlsx',
      createdAt: new Date().toISOString(),
      createdDisplay: now(),
      newCount: seed.length,
      updatedCount: 0,
      skippedCount: 0,
      errorCount: 0
    });

    await audit(
      '',
      'کاتالوگ اولیه',
      'بارگذاری اولیه کاتالوگ',
      '',
      `${seed.length} کالا از فایل اصلی`
    );

    notify(`کاتالوگ اصلی با ${fmt(seed.length)} کالا بارگذاری شد.`);
  } catch (e) {
    console.warn('seed skipped:', e.message);
  }
}

async function refreshAll() {
  await renderProducts(true);
  await renderRules();
  await renderHistory(true);
  await renderSources();
}

async function init() {
  db = await openDB();

  if (!await get('settings', 'defaultProfit')) {
    await put('settings', {
      key: 'defaultProfit',
      value: 15
    });
  }

  if (!await get('settings', 'actor')) {
    await put('settings', {
      key: 'actor',
      value: 'کاربر'
    });
  }

  if (!await get('settings', 'currency')) {
    await put('settings', {
      key: 'currency',
      value: 'ریال'
    });
  }

  await seedIfEmpty();
  await refreshAll();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  $('dbStat').textContent = 'ذخیره‌شده روی همین دستگاه';
}

init().catch(e => {
  console.error(e);
  notify('برنامه نتوانست پایگاه داده محلی را باز کند.');
});

/* =========================================================
   اتصال اسکنر بارکد به جست‌وجوی یدک‌پرایس
   این بخش را به انتهای app.js اضافه کنید.
   ========================================================= */

/* OCR خواندن نوشته روی جعبه و تایپ خودکار */


/* OCR فارسی و انگلیسی */

let yadakTextStream = null;
let yadakTextBusy = false;

function stopYadakTextScanner() {
  if (yadakTextStream) {
    yadakTextStream.getTracks().forEach(track => track.stop());
    yadakTextStream = null;
  }
}

async function startTextScanner() {
  if (yadakTextBusy || yadakTextStream) return;
  yadakTextBusy = true;

  try {
    if (!window.Tesseract) {
      notify('در حال بارگذاری متن‌خوان...');
      await loadScript(
        'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'
      );
    }

    showModal('خواندن نوشته روی قطعه', `
      <video id="textCamera" autoplay playsinline
        style="width:100%;border-radius:12px;background:#111"></video>
      <canvas id="textCanvas" hidden></canvas>
      <p>نوشته را نزدیک، واضح و زیر نور مناسب بگیر.</p>
      <button id="captureText" class="primary">
        خواندن و تایپ نوشته
      </button>
      <button id="cancelTextScan" class="ghost">انصراف</button>
    `);

    const video = $('textCamera');

    yadakTextStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      }
    });

    video.srcObject = yadakTextStream;
    await video.play();

    $('cancelTextScan').onclick = () => {
      stopYadakTextScanner();
      closeModal();
    };

    $('captureText').onclick = async () => {
      const button = $('captureText');
      if (button.disabled) return;
      button.disabled = true;

      let worker;

      try {
        const canvas = $('textCanvas');

        if (!video.videoWidth) {
          throw new Error('دوربین آماده نیست.');
        }

        canvas.width = video.videoWidth * 2;
        canvas.height = video.videoHeight * 2;

        const ctx = canvas.getContext('2d', {
          willReadFrequently: true
        });

        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const image = ctx.getImageData(
          0, 0, canvas.width, canvas.height
        );

        const pixels = image.data;

        for (let i = 0; i < pixels.length; i += 4) {
          const gray = Math.round(
            pixels[i] * 0.299 +
            pixels[i + 1] * 0.587 +
            pixels[i + 2] * 0.114
          );

          const contrast = Math.max(
            0, Math.min(255, (gray - 128) * 1.45 + 128)
          );

          pixels[i] = contrast;
          pixels[i + 1] = contrast;
          pixels[i + 2] = contrast;
        }

        ctx.putImageData(image, 0, 0);

        notify('در حال بارگذاری زبان فارسی...');

        worker = await window.Tesseract.createWorker(
          'fas+eng',
          1,
          {
            langPath: 'https://tessdata.projectnaptha.com/4.0.0',
            logger: message => {
              if (message.status === 'recognizing text') {
                notify(
                  'تشخیص متن: ' +
                  Math.round((message.progress || 0) * 100) + '%'
                );
              }
            }
          }
        );

        const result = await worker.recognize(canvas);

        const recognized = String(result?.data?.text || '')
          .replace(/\s+/g, ' ')
          .trim();

        if (!recognized) {
          notify('متنی خوانده نشد؛ نور و وضوح تصویر را بهتر کن.');
          return;
        }

        stopYadakTextScanner();
        closeModal();

        $('search').value = recognized;
        await renderProducts(true);

        notify('متن وارد جست‌وجو شد.');
      } catch (error) {
        console.error('OCR error:', error);
        notify(
          'خطای متن‌خوان: ' +
          (error.message || 'اتصال اینترنت یا زبان فارسی را بررسی کن.')
        );
      } finally {
        if (worker) {
          try {
            await worker.terminate();
          } catch (_) {}
        }

        if ($('captureText')) {
          $('captureText').disabled = false;
        }
      }
    };
  } catch (error) {
    console.error(error);
    stopYadakTextScanner();

    if ($('modalBackdrop')) closeModal();

    notify('خطای دوربین: ' + (error.message || ''));
  } finally {
    yadakTextBusy = false;
  }
}

if ($('scanTextBtn')) {
  $('scanTextBtn').addEventListener('click', startTextScanner);
}

if ($('closeModal')) {
  $('closeModal').addEventListener(
    'click',
    stopYadakTextScanner
  );
}

if ($('modalBackdrop')) {
  $('modalBackdrop').addEventListener('click', event => {
    if (event.target === $('modalBackdrop')) {
      stopYadakTextScanner();
    }
  });
}

