/**
 * Content script для Ringme (ringmeadmin.tlpn).
 * Парсит результаты поиска, находит ссылку на клиента, ссылку на Teleo.
 */

(function () {
  'use strict';

  function extractSearchResults() {
    const results = [];
    const rows = document.querySelectorAll('table tr, .client-row, .search-result');
    for (const row of rows) {
      const links = row.querySelectorAll('a');
      const text = row.textContent.trim().substring(0, 500);
      const hrefs = Array.from(links).map(a => ({ text: a.textContent.trim(), href: a.href }));
      if (hrefs.length > 0) {
        results.push({ text, links: hrefs });
      }
    }
    return results;
  }

  function findTeleoLink() {
    const links = document.querySelectorAll('a');
    for (const a of links) {
      if (/teleo|apiproxy.*continue_url/i.test(a.href)) {
        return a.href;
      }
    }
    return '';
  }

  function findClientCardLink() {
    const links = document.querySelectorAll('a');
    for (const a of links) {
      if (/client|customer|карточка/i.test(a.textContent) ||
          /\/clients\/\d+/i.test(a.href)) {
        return a.href;
      }
    }
    return '';
  }

  function collectData() {
    return {
      source: 'ringme',
      url: window.location.href,
      searchResults: extractSearchResults(),
      teleoLink: findTeleoLink(),
      clientCardLink: findClientCardLink()
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'PARSE_RINGME') {
      try {
        sendResponse({ ok: true, data: collectData() });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return true;
    }
  });

  // Авто-уведомление
  setTimeout(() => {
    chrome.runtime.sendMessage({ type: 'RINGME_DATA_READY', data: collectData() });
  }, 1000);
})();
