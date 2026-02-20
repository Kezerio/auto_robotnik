/**
 * Content script для Accounting (intra10.office.tlpn/admin/customer_show.php).
 * Извлекает: lineNumber, services, clientCode.
 */

(function () {
  'use strict';

  const LINE_HEADER_RE = /Линия\s+номер\s+(\d+)\s*\/?\s*(\d*)/i;

  function extractLineNumber() {
    const body = document.body.textContent;
    const m = LINE_HEADER_RE.exec(body);
    if (m) {
      return { lineNumber: m[1], lineNumberAlt: m[2] || '' };
    }
    // Fallback: ищем в заголовках
    const headers = document.querySelectorAll('h1, h2, h3, h4, .page-title, .header');
    for (const h of headers) {
      const hm = LINE_HEADER_RE.exec(h.textContent);
      if (hm) return { lineNumber: hm[1], lineNumberAlt: hm[2] || '' };
    }
    return { lineNumber: '', lineNumberAlt: '' };
  }

  function extractServices() {
    const services = [];
    // Ищем таблицы с услугами
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const headers = Array.from(table.querySelectorAll('th, thead td'))
        .map(th => th.textContent.trim().toLowerCase());

      // Эвристика: таблица с заголовками типа "услуга", "тариф", "статус" и т.д.
      const isServiceTable = headers.some(h =>
        /услуг|service|тариф|tariff|название|name/i.test(h)
      );

      if (isServiceTable || tables.length === 1) {
        const rows = table.querySelectorAll('tbody tr, tr');
        for (const row of rows) {
          if (row.querySelector('th')) continue; // skip header rows
          const cells = Array.from(row.querySelectorAll('td'))
            .map(td => td.textContent.trim());
          if (cells.length > 0 && cells.some(c => c.length > 0)) {
            services.push({
              cells,
              raw: row.textContent.trim().substring(0, 300)
            });
          }
        }
      }
    }
    return services;
  }

  function extractClientCode() {
    const params = new URLSearchParams(window.location.search);
    const otrsCustomer = params.get('otrs_customer') || '';
    const m = otrsCustomer.match(/^([A-Z]{3}\d{5})/);
    return m ? m[1] : otrsCustomer;
  }

  function collectAccountingData() {
    const line = extractLineNumber();
    return {
      source: 'accounting',
      url: window.location.href,
      clientCode: extractClientCode(),
      lineNumber: line.lineNumber,
      lineNumberAlt: line.lineNumberAlt,
      services: extractServices()
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'PARSE_ACCOUNTING') {
      try {
        const data = collectAccountingData();
        sendResponse({ ok: true, data });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return true;
    }
  });

  // Авто-отправка данных
  setTimeout(() => {
    const data = collectAccountingData();
    chrome.runtime.sendMessage({ type: 'ACCOUNTING_DATA_READY', data });
  }, 1000);
})();
