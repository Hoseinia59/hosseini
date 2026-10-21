/* Yadak Price - PDF & Image OCR Engine
   پشتیبانی از PDF متنی، PDF اسکن‌شده و عکس لیست قیمت
   OCR فارسی و انگلیسی
*/

(() => {
  'use strict';

  const PDFJS_URL =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';

  const PDF_WORKER_URL =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  const TESSERACT_URL =
    'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

  const LANG_URL =
    'https://tessdata.projectnaptha.com/4.0.0';

  let workerPromise = null;

  function loadScript(url, globalName) {
    if (window[globalName]) {
      return Promise.resolve(window[globalName]);
    }

    return new Promise((resolve, reject) => {
      const script = document.createElement('script');

      script.src = url;

      script.onload = () => {
        if (window[globalName]) {
          resolve(window[globalName]);
        } else {
          reject(new Error('کتابخانه بارگیری شد ولی فعال نیست.'));
        }
      };

      script.onerror = () => {
        reject(new Error(
          'بارگیری کتابخانه ناموفق بود. اتصال اینترنت را بررسی کن.'
        ));
      };

      document.head.appendChild(script);
    });
  }

  async function getOCRWorker() {
    if (!workerPromise) {
      workerPromise = (async () => {
        await loadScript(TESSERACT_URL, 'Tesseract');

        return window.Tesseract.createWorker(
          'fas+eng',
          1,
          {
            langPath: LANG_URL,
            logger: info => {
              if (info.status) {
                console.log(
                  'وضعیت OCR:',
                  info.status,
                  Math.round((info.progress || 0) * 100) + '%'
                );
              }
            }
          }
        );
      })().catch(error => {
        workerPromise = null;
        throw error;
      });
    }

    return workerPromise;
  }

  function normalizeDigits(value) {
    return String(value ?? '')
      .replace(/[۰-۹]/g, d =>
        '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)
      )
      .replace(/[٠-٩]/g, d =>
        '٠١٢٣٤٥٦٧٨٩'.indexOf(d)
      );
  }

  function parsePrice(value) {
    const normalized = normalizeDigits(value)
      .replace(/[٬،,\s]/g, '')
      .replace(/[^\d]/g, '');

    const number = Number(normalized);

    return Number.isSafeInteger(number) ? number : 0;
  }

  function cleanText(value) {
    return String(value ?? '')
      .replace(/\u0000/g, ' ')
      .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  function findPrices(line) {
    const text = normalizeDigits(line);

    const regex = /\d[\d\s,٬،.]{2,}\d|\d{4,}/g;

    const prices = [];

    for (const match of text.matchAll(regex)) {
      const price = parsePrice(match[0]);

      if (price >= 1000 && price <= 99999999999) {
        prices.push({
          value: price,
          index: match.index,
          length: match[0].length
        });
      }
    }

    return prices;
  }

  function extractRows(text, pageNumber, sourceType) {
    const lines = String(text || '')
      .split(/\n/)
      .map(cleanText)
      .filter(line => line.length > 1);

    const result = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (/^(صفحه|page)\s*\d+/i.test(line)) {
        continue;
      }

      const prices = findPrices(line);

      if (!prices.length) {
        continue;
      }

      // اگر چند عدد شبیه قیمت وجود داشته باشد،
      // بزرگ‌ترین مقدار پیشنهاد می‌شود و برای بررسی علامت می‌خورد.
      const selected = prices.reduce((a, b) =>
        a.value > b.value ? a : b
      );

      let name = line;

      [...prices]
        .sort((a, b) => b.index - a.index)
        .forEach(item => {
          name =
            name.slice(0, item.index) +
            ' ' +
            name.slice(item.index + item.length);
        });

      name = cleanText(
        name.replace(/[|│¦:؛;]+/g, ' ')
      );

      // بعضی فایل‌ها نام قطعه را در یک خط
      // و قیمت را در خط بعدی قرار می‌دهند.
      if (
        name.replace(/\W/g, '').length < 2 &&
        i > 0 &&
        !findPrices(lines[i - 1]).length
      ) {
        name = cleanText(lines[i - 1] + ' ' + name);
      }

      if (name.length < 2 || name.length > 220) {
        continue;
      }

      let status = 'نیازمند بررسی';

      if (prices.length === 1 && name.length >= 3) {
        status = 'تشخیص اولیه';
      }

      result.push({
        name,
        price: selected.value,
        page: pageNumber,
        status,
        sourceType
      });
    }

    return result;
  }

  async function renderPDFPage(page) {
    const viewport = page.getViewport({
      scale: 2
    });

    const canvas = document.createElement('canvas');

    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);

    const context = canvas.getContext('2d', {
      alpha: false
    });

    context.fillStyle = '#ffffff';

    context.fillRect(
      0,
      0,
      canvas.width,
      canvas.height
    );

    await page.render({
      canvasContext: context,
      viewport
    }).promise;

    return canvas;
  }

  async function recognizeImage(image) {
    const worker = await getOCRWorker();

    const result = await worker.recognize(image);

    return result?.data?.text || '';
  }

  async function extractPDF(file) {
    await loadScript(PDFJS_URL, 'pdfjsLib');

    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      PDF_WORKER_URL;

    const buffer = new Uint8Array(
      await file.arrayBuffer()
    );

    const pdf = await window.pdfjsLib
      .getDocument({ data: buffer })
      .promise;

    if (pdf.numPages > 250) {
      throw new Error(
        'این نسخه فعلاً PDFهای حداکثر ۲۵۰ صفحه‌ای را پردازش می‌کند.'
      );
    }

    const allRows = [];

    let textPages = 0;

    for (let number = 1; number <= pdf.numPages; number++) {
      if (typeof window.notify === 'function') {
        window.notify(
          `پردازش PDF: صفحه ${number} از ${pdf.numPages}`
        );
      }

      const page = await pdf.getPage(number);

      const content = await page.getTextContent();

      // مرتب‌سازی متن براساس مختصات خطوط PDF
      const lines = [];

      for (const item of content.items || []) {
        if (
          typeof item.str !== 'string' ||
          !item.str.trim()
        ) {
          continue;
        }

        const x = Number(item.transform?.[4] || 0);
        const y = Number(item.transform?.[5] || 0);

        let line = lines.find(
          entry => Math.abs(entry.y - y) <= 3
        );

        if (!line) {
          line = { y, items: [] };
          lines.push(line);
        }

        line.items.push({ x, text: item.str });
      }

      lines.sort((a, b) => b.y - a.y);

      let pageText = lines.map(line => {
        line.items.sort((a, b) => b.x - a.x);

        return cleanText(
          line.items.map(item => item.text).join(' ')
        );
      }).filter(Boolean).join('\n');

      const meaningfulCharacters =
        pageText.replace(/[\s\W_]/g, '').length;

      let sourceType = 'PDF متنی';

      // صفحه بدون متن قابل‌استفاده احتمالاً اسکن‌شده است.
      if (meaningfulCharacters < 18) {
        sourceType = 'OCR';

        if (typeof window.notify === 'function') {
          window.notify(
            `صفحه ${number}: تشخیص تصویر و اجرای OCR`
          );
        }

        const canvas = await renderPDFPage(page);

        pageText = await recognizeImage(canvas);

        canvas.width = 1;
        canvas.height = 1;
      } else {
        textPages++;
      }

      allRows.push(
        ...extractRows(pageText, number, sourceType)
      );
    }

    if (!allRows.length) {
      throw new Error(
        'قیمت قابل تشخیصی پیدا نشد. کیفیت PDF یا ساختار جدول را بررسی کن.'
      );
    }

    return {
      rows: allRows,
      pageCount: pdf.numPages,
      textPages
    };
  }

  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[char]);
  }

  function showResults(result, fileName, onContinue) {
    const rows = result.rows;

    const reviewCount = rows.filter(
      row => row.status !== 'تشخیص اولیه'
    ).length;

    const sample = rows.slice(0, 15);

    const body = sample.map(row => `
      <tr>
        <td>${row.page}</td>
        <td>${escapeHTML(row.name)}</td>
        <td>${row.price.toLocaleString('fa-IR')}</td>
        <td>${escapeHTML(row.status)}</td>
      </tr>
    `).join('');

    window.showModal(
      'گزارش تشخیص PDF',
      `
        <p>
          فایل:
          <b>${escapeHTML(fileName)}</b>
        </p>

        <div class="import-summary">
          <span>تعداد صفحات: ${result.pageCount}</span>
          <span>ردیف‌ها: ${rows.length}</span>
          <span>صفحات متنی: ${result.textPages}</span>
          <span>نیازمند بررسی: ${reviewCount}</span>
        </div>

        <p>
          قیمت‌ها پیشنهادی هستند. قبل از ثبت نهایی،
          ردیف‌ها و واحد پول را بررسی کن.
        </p>

        <div style="overflow:auto;max-height:35vh">
          <table class="import-preview-table">
            <thead>
              <tr>
                <th>صفحه</th>
                <th>نام کالا</th>
                <th>قیمت</th>
                <th>وضعیت</th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>

        ${
          rows.length > sample.length
            ? `<p>۱۵ ردیف اول از ${rows.length} ردیف نمایش داده شده است.</p>`
            : ''
        }

        <div class="modal-actions">
          <button class="primary" id="ocrContinue">
            ادامه به پیش‌نمایش ورود
          </button>

          <button class="ghost" id="ocrCancel">
            انصراف
          </button>
        </div>
      `
    );

    document.getElementById('ocrCancel').onclick =
      () => window.closeModal();

    document.getElementById('ocrContinue').onclick = () => {
      window.closeModal();

      const matrix = [
        ['نام کالا', 'قیمت', 'صفحه PDF', 'وضعیت تشخیص'],
        ...rows.map(row => [
          row.name,
          row.price,
          row.page,
          row.status
        ])
      ];

      onContinue(matrix);
    };
  }

  async function handlePDF(file) {
    if (!file) return;

    try {
      const result = await extractPDF(file);

      showResults(
        result,
        file.name,
        matrix => window.buildImportPreview(matrix, file.name)
      );
    } catch (error) {
      console.error(error);

      window.notify(
        'خطا در پردازش PDF: ' +
        (error.message || error)
      );
    }
  }

  async function handleImage(file) {
    if (!file) return;

    try {
      if (typeof window.notify === 'function') {
        window.notify('در حال تشخیص متن و قیمت‌های عکس…');
      }

      const text = await recognizeImage(file);

      const rows = extractRows(
        text,
        1,
        'OCR عکس'
      );

      if (!rows.length) {
        throw new Error(
          'قیمت قابل تشخیصی پیدا نشد. عکس واضح‌تر بگیر.'
        );
      }

      showResults(
        {
          rows,
          pageCount: 1,
          textPages: 0
        },
        file.name,
        matrix => window.buildImportPreview(matrix, file.name)
      );
    } catch (error) {
      console.error(error);

      window.notify(
        'خطا در خواندن عکس: ' +
        (error.message || error)
      );
    }
  }

  function attachEvents() {
    const pdfInput = document.getElementById('pdfFile');

    if (pdfInput) {
      pdfInput.onchange = async event => {
        const file = event.target.files?.[0];

        await handlePDF(file);

        event.target.value = '';
      };
    }

    const imageInput = document.getElementById('imageFile');

    if (imageInput) {
      imageInput.onchange = async event => {
        const file = event.target.files?.[0];

        await handleImage(file);

        event.target.value = '';
      };
    }
  }

  window.YadakPdfOcr = {
    extractPDF,
    extractRows,
    handlePDF,
    handleImage
  };

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      attachEvents,
      { once: true }
    );
  } else {
    attachEvents();
  }
})();