'use strict';
/* =========================================================================
   یدک‌پرایس — منطق برنامه (نسخه موبایلی، آفلاین، مبتنی بر IndexedDB)
   ========================================================================= */

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
  return String(v ?? '').toLowerCase().replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[ۀة]/g, 'ه').replace(/ـ/g, '').replace(/[\u200c\u200f\u200e]/g, ' ').replace(/[.\-_/]/g, ' ').replace(/\s+/g, ' ').trim();
}
function faNum(v) {
  return String(v ?? '').replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
}
function num(v) {
  let s = faNum(v).replace(/[٬,،\s]/g, '').replace(/ریال|تومان/g, '').replace(/٫/g, '.');
  if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
function fmt(v) { return Math.round(Number(v) || 0).toLocaleString('fa-IR'); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function splitList(v) { return String(v ?? '').split(/[,،\n]/).map(x => x.trim()).filter(Boolean); }

function notify(s) {
  if(!$('toast')) return;
  $('toast').textContent = s;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3200);
}

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res;
    s.onerror = () => rej(new Error('بارگذاری کتابخانه ناموفق بود؛ به اینترنت نیاز است.'));
    document.head.appendChild(s);
  });
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
      for (const [name, key] of [['rules', 'id'], ['history', 'id'], ['settings', 'key'], ['sources', 'id']]) {
        if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: key });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function all(store) {
  return new Promise((res, rej) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); });
}
function get(store, key) {
  return new Promise((res, rej) => { const r = db.transaction(store).objectStore(store).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
function put(store, value) {
  return new Promise((res, rej) => { const t = db.transaction(store, 'readwrite'); t.objectStore(store).put(value); t.oncomplete = () => res(value); t.onerror = () => rej(t.error); });
}
function putMany(store, values) {
  if (!values || values.length === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(store, 'readwrite'); const objectStore = tx.objectStore(store);
      for (const value of values) objectStore.put(value);
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error || new Error('ثبت گروهی اطلاعات ناموفق بود.')); tx.onabort = () => reject(tx.error || new Error('ثبت گروهی اطلاعات لغو شد.'));
    } catch (err) { reject(err); }
  });
}
function del(store, key) {
  return new Promise((res, rej) => { const t = db.transaction(store, 'readwrite'); t.objectStore(store).delete(key); t.oncomplete = res; t.onerror = () => rej(t.error); });
}
function clearStore(store) {
  return new Promise((res, rej) => { const t = db.transaction(store, 'readwrite'); t.objectStore(store).clear(); t.oncomplete = res; t.onerror = () => rej(t.error); });
}
async function setting(key, def) { const x = await get('settings', key); return x ? x.value : def; }
async function audit(productId, productName, field, oldValue, newValue, actor) {
  actor = actor || await setting('actor', 'کاربر');
  await put('history', { id: uid(), productId, productName, field, oldValue: String(oldValue ?? ''), newValue: String(newValue ?? ''), actor, at: new Date().toISOString(), displayAt: now() });
}

/* ---------------------------- موتور قیمت‌گذاری ---------------------------- */
function isFinalPrice(p) { return p.priceType === 'final'; }
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
  if (isFinalPrice(p)) return { percent: 0, origin: 'final', label: 'قیمت نهایی · بدون سود اضافه' };
  if (p.itemProfitPercent !== null && p.itemProfitPercent !== undefined && p.itemProfitPercent !== '') { return { percent: Number(p.itemProfitPercent), origin: 'item', label: `سود اختصاصی کالا ${fmt(p.itemProfitPercent)}٪` }; }
  const rule = matchedRule(p, rules);
  if (rule) return { percent: Number(rule.percent), origin: 'group', label: `قاعده گروهی (${[rule.term, rule.brand].filter(Boolean).join(' · ')}) ${fmt(rule.percent)}٪` };
  return { percent: Number(defaultProfit), origin: 'default', label: `سود پیش‌فرض ${fmt(defaultProfit)}٪` };
}
function sellPrice(p, rules, defaultProfit) {
  if (isFinalPrice(p)) return Number(p.basePrice) || 0;
  const raw = (Number(p.basePrice) || 0) * (1 + profitInfo(p, rules, defaultProfit).percent / 100);
  return Math.round(raw);
}

/* ------------------------------ موتور جست‌وجو ------------------------------ */
function matchTier(p, qWords, qNorm) {
  const name = norm(p.name), brand = norm(p.brand), cars = norm((p.cars || []).join(' ')), code = norm(p.code), oem = norm(p.oem), barcode = norm(p.barcode), alt = norm((p.altNames || []).join(' '));
  if (qNorm && (code === qNorm || oem === qNorm) && (code || oem)) return 0;
  if (qNorm && barcode && barcode === qNorm) return 1;
  if (qNorm && name === qNorm) return 2;
  const inName = w => name.includes(w), inNameBrand = w => name.includes(w) || brand.includes(w), inNameCar = w => name.includes(w) || cars.includes(w), inAlt = w => alt.includes(w);
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
  const scored = [], unmatched = [];
  for (const p of products) {
    const tier = matchTier(p, qWords, qNorm);
    if (tier !== null) scored.push({ p, tier }); else unmatched.push(p);
  }
  if (qWords.length === 1 && qWords[0].length >= 3 && qWords[0].length <= 20) {
    const maxDist = qWords[0].length <= 5 ? 1 : 2;
    for (const p of unmatched) {
      const tokens = norm(p.name).split(' ');
      const hit = tokens.some(t => t.length >= 3 && levenshtein(t, qWords[0], maxDist) <= maxDist);
      if (hit) scored.push({ p, tier: 8 });
    }
  }
  scored.sort((a, b) => a.tier - b.tier || norm(a.p.name).localeCompare(norm(b.p.name), 'fa'));
  return scored.map(x => x.p);
}

/* -------------------------------- رندر کالاها -------------------------------- */
async function getFiltered() {
  const products = await all('products');
  let rows = searchProducts(products, $('search') ? $('search').value : '');
  const brand = $('filterBrand') ? $('filterBrand').value : '';
  const source = $('filterSource') ? $('filterSource').value : '';
  const ptype = $('filterPriceType') ? $('filterPriceType').value : '';
  const minP = $('filterMinPrice') ? num($('filterMinPrice').value) : 0;
  const maxP = $('filterMaxPrice') ? num($('filterMaxPrice').value) : 0;
  const hasCode = $('filterHasCode') ? $('filterHasCode').checked : false;

  if (brand) rows = rows.filter(p => p.brand === brand);
  if (source) rows = rows.filter(p => p.source === source);
  if (ptype) rows = rows.filter(p => (p.priceType || 'base') === ptype);
  if (hasCode) rows = rows.filter(p => p.code);

  const rules = await all('rules');
  const defaultProfit = await setting('defaultProfit', 15);
  let withPrice = rows.map(p => ({ p, sell: sellPrice(p, rules, defaultProfit), info: profitInfo(p, rules, defaultProfit) }));
  if (minP > 0) withPrice = withPrice.filter(x => x.sell >= minP);
  if (maxP > 0) withPrice = withPrice.filter(x => x.sell <= maxP);
  return withPrice;
}
async function populateFilterOptions() {
  const products = await all('products');
  const brands = [...new Set(products.map(p => p.brand).filter(Boolean))].sort((a, b) => norm(a).localeCompare(norm(b), 'fa'));
  const sources = [...new Set(products.map(p => p.source).filter(Boolean))].sort((a, b) => norm(a).localeCompare(norm(b), 'fa'));
  const fillSelect = (sel, items, current) => {
    if(sel) sel.innerHTML = sel.querySelector('option').outerHTML + items.map(v => `<option ${v === current ? 'selected' : ''}>${esc(v)}</option>`).join('');
  };
  fillSelect($('filterBrand'), brands, $('filterBrand') ? $('filterBrand').value : '');
  fillSelect($('filterSource'), sources, $('filterSource') ? $('filterSource').value : '');
}
async function renderProducts(resetPage) {
  if (resetPage) productPage = 1;
  const rows = await getFiltered();
  if($('countStat')) $('countStat').textContent = `${fmt(rows.length)} کالا`;
  const visible = rows.slice(0, productPage * PAGE_SIZE);

  if($('productList')) {
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
          <div><div class="price">${fmt(sell)} <small>ریال</small></div><div class="subprice">قیمت پایه: ${fmt(p.basePrice)} · ${esc(p.priceType === 'final' ? 'قیمت نهایی' : 'قیمت پایه')}</div></div>
          <span class="pill">${esc(p.source || 'ورود دستی')}</span>
        </div>
        <div class="card-actions">
          <button class="small-btn" data-edit="${p.id}">ویرایش</button>
          <button class="small-btn" data-hist="${p.id}">سابقه تغییر</button>
          <button class="small-btn" data-delete="${p.id}">حذف</button>
        </div>
      </article>
    `).join('');
    $('productList').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editProduct(b.dataset.edit));
    $('productList').querySelectorAll('[data-hist]').forEach(b => b.onclick = () => showProductHistory(b.dataset.hist));
    $('productList').querySelectorAll('[data-delete]').forEach(b => b.onclick = () => deleteProduct(b.dataset.delete));
  }
  if($('emptyProducts')) {
    $('emptyProducts').classList.toggle('hidden', rows.length > 0);
    $('emptyProducts').textContent = ($('search') && $('search').value.trim()) ? 'نتیجه‌ای پیدا نشد.' : 'هنوز کالایی ثبت نشده است. از «کالای جدید» شروع کن.';
  }
  if($('loadMoreBtn')) $('loadMoreBtn').classList.toggle('hidden', visible.length >= rows.length);
  await populateFilterOptions();
}
if($('loadMoreBtn')) $('loadMoreBtn').onclick = () => { productPage++; renderProducts(false); };

/* -------------------------------- مودال و فرم کالا -------------------------------- */
function showModal(title, html) {
  if($('modalTitle')) $('modalTitle').textContent = title;
  if($('modalBody')) $('modalBody').innerHTML = html;
  if($('modalBackdrop')) $('modalBackdrop').classList.remove('hidden');
}
function closeModal() { if($('modalBackdrop')) $('modalBackdrop').classList.add('hidden'); }

async function editProduct(id) {
  const p = id ? await get('products', id) : { id: uid(), name: '', altNames: [], brand: '', cars: [], code: '', oem: '', barcode: '', basePrice: 0, priceType: 'base', itemProfitPercent: '', source: 'ورود دستی' };
  showModal(id ? 'ویرایش کالا' : 'ثبت کالای جدید', `
    <form id="productForm" class="modal-form">
      <label>نام کالا * <input name="name" required value="${esc(p.name)}"></label>
      <label>نام‌های جایگزین (با کاما)<input name="altNames" value="${esc((p.altNames || []).join('، '))}"></label>
      <div class="two"><label>برند<input name="brand" value="${esc(p.brand)}"></label><label>خودروها<input name="cars" value="${esc((p.cars || []).join('، '))}"></label></div>
      <div class="two"><label>کد فنی<input name="code" value="${esc(p.code)}"></label><label>کد OEM<input name="oem" value="${esc(p.oem)}"></label></div>
      <div class="two"><label>بارکد<input name="barcode" value="${esc(p.barcode)}"></label><label>قیمت پایه (ریال) *<input name="basePrice" inputmode="decimal" required value="${esc(p.basePrice)}"></label></div>
      <div class="two">
        <label>نوع قیمت<select name="priceType"><option value="base" ${p.priceType !== 'final' ? 'selected' : ''}>قیمت پایه (سود اعمال شود)</option><option value="final" ${p.priceType === 'final' ? 'selected' : ''}>قیمت نهایی</option></select></label>
        <label>سود اختصاصی (٪)<input name="itemProfitPercent" type="number" min="0" max="500" step="0.1" value="${esc(p.itemProfitPercent ?? '')}"></label>
      </div>
      <label>منبع قیمت<input name="source" value="${esc(p.source || 'ورود دستی')}"></label>
      <div class="modal-actions"><button class="primary" type="submit">ذخیره کالا</button><button class="ghost" type="button" id="cancelProduct">انصراف</button></div>
    </form>
  `);
  $('cancelProduct').onclick = closeModal;
  $('productForm').onsubmit = async e => {
    e.preventDefault(); const f = new FormData(e.target);
    const next = { ...p, name: String(f.get('name')).trim(), altNames: splitList(f.get('altNames')), brand: String(f.get('brand')).trim(), cars: splitList(f.get('cars')), code: String(f.get('code')).trim(), oem: String(f.get('oem')).trim(), barcode: String(f.get('barcode')).trim(), basePrice: num(f.get('basePrice')), priceType: f.get('priceType'), itemProfitPercent: f.get('itemProfitPercent') === '' ? '' : Number(f.get('itemProfitPercent')), source: String(f.get('source')).trim() || 'ورود دستی', updatedAt: new Date().toISOString() };
    if (!next.name || next.basePrice <= 0) return notify('نام کالا و قیمت پایه معتبر لازم است.');
    await put('products', next);
    if (!id) await audit(next.id, next.name, 'ثبت کالا', '', `${next.basePrice} ریال`);
    closeModal(); await renderProducts(true); notify('کالا ذخیره شد.');
  };
}
async function deleteProduct(id) {
  const p = await get('products', id);
  if (!p || !confirm(`کالای «${p.name}» حذف شود؟`)) return;
  await audit(id, p.name, 'حذف کالا', 'موجود', 'حذف شد');
  await del('products', id); await renderProducts(true); notify('کالا حذف شد');
}
async function showProductHistory(id) {
  const h = (await all('history')).filter(x => x.productId === id).sort((a, b) => b.at.localeCompare(a.at));
  showModal('سابقه تغییرات کالا', h.length ? `<div class="stack">${h.map(x => `<div class="list-row"><b>${esc(x.field)}</b><small>${esc(x.displayAt || x.at)} · ${esc(x.actor || 'کاربر')}</small><div>${esc(x.oldValue || '—')} ← ${esc(x.newValue || '—')}</div></div>`).join('')}</div>` : '<div class="empty">برای این کالا سابقه‌ای ثبت نشده است.</div>');
}

/* -------------------------------- قواعد سود گروهی -------------------------------- */
async function renderRules() {
  const rs = (await all('rules')).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  if($('ruleList')) {
    $('ruleList').innerHTML = rs.map(r => `<div class="list-row"><b>${esc(r.term || 'همه کالاها')} ${r.brand ? '· ' + esc(r.brand) : ''}</b><small>سود ${fmt(r.percent)}٪ · ${esc(r.createdDisplay || '')}</small><div class="card-actions"><button class="small-btn" data-rdel="${r.id}">حذف قاعده</button></div></div>`).join('') || '<div class="empty">قاعده‌ای ثبت نشده.</div>';
    $('ruleList').querySelectorAll('[data-rdel]').forEach(b => b.onclick = async () => { await del('rules', b.dataset.rdel); await renderRules(); await renderProducts(true); notify('قاعده حذف شد'); });
  }
}
if($('ruleForm')) $('ruleForm').onsubmit = async e => {
  e.preventDefault();
  const term = $('ruleTerm').value.trim(), brand = $('ruleBrand').value.trim(), percent = Number($('rulePercent').value);
  if (!term && !brand) return notify('عبارت نام کالا یا برند را وارد کن.');
  await put('rules', { id: uid(), term, brand, percent, createdAt: new Date().toISOString(), createdDisplay: now() });
  e.target.reset(); $('rulePercent').value = 10;
  await renderRules(); await renderProducts(true); notify('قاعده ثبت شد');
};

/* -------------------------------- تاریخچه -------------------------------- */
async function renderHistory(resetPage) {
  if (resetPage) historyPage = 1;
  let hs = (await all('history')).sort((a, b) => b.at.localeCompare(a.at));
  const q = $('historySearch') ? norm($('historySearch').value) : '';
  if (q) hs = hs.filter(h => norm([h.productName, h.field, h.actor, h.oldValue, h.newValue].join(' ')).includes(q));
  const visible = hs.slice(0, historyPage * 60);
  if($('historyList')) $('historyList').innerHTML = visible.map(h => `<div class="list-row"><b>${esc(h.productName || 'تغییرات سیستم')} · ${esc(h.field)}</b><small>${esc(h.displayAt || h.at)} · ${esc(h.actor || 'کاربر')}</small><div>${esc(h.oldValue || '—')} ← ${esc(h.newValue || '—')}</div></div>`).join('') || '<div class="empty">هنوز تغییری ثبت نشده است.</div>';
  if($('historyMoreBtn')) $('historyMoreBtn').classList.toggle('hidden', visible.length >= hs.length);
}
if($('historyMoreBtn')) $('historyMoreBtn').onclick = () => { historyPage++; renderHistory(false); };
if($('historySearch')) $('historySearch').oninput = () => renderHistory(true);
if($('clearHistory')) $('clearHistory').onclick = async () => { if (confirm('تمام تاریخچه پاک شود؟')) {
