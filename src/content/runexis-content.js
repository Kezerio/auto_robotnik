/**
 * Content script для Runexis DID Trunk — подбор номеров.
 * Домен: did-trunk.runexis.ru
 *
 * Обрабатывает сообщения:
 * - RUNEXIS_CHECK_AUTH — проверка авторизации
 * - RUNEXIS_SET_FILTERS — заполнить фильтры (город, тип, код)
 * - RUNEXIS_APPLY_FILTERS — нажать "Применить"
 * - RUNEXIS_GO_TO_PAGE — перейти на нужную страницу пагинации
 * - RUNEXIS_COLLECT_NUMBERS — собрать номера со страницы
 */
(function () {
  'use strict';

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'RUNEXIS_CHECK_AUTH': {
        // Проверяем, находимся ли мы на странице логина
        const isLoginPage = window.location.pathname.includes('/site/login')
          || !!document.querySelector('form#login-form')
          || !!document.querySelector('input[name="LoginForm[username]"]');
        const isNumbersPage = window.location.pathname.includes('/numbers');
        sendResponse({ ok: true, isLoginPage, isNumbersPage, url: window.location.href });
        return true;
      }

      case 'RUNEXIS_SET_FILTERS': {
        try {
          const { city, numberType, code } = msg;
          setFilters(city, numberType, code);
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        return true;
      }

      case 'RUNEXIS_APPLY_FILTERS': {
        const applyBtn = findButtonByText('Применить')
          || findButtonByText('Поиск')
          || findButtonByText('Найти')
          || document.querySelector('button[type="submit"]')
          || document.querySelector('.btn-primary');
        if (applyBtn) {
          applyBtn.click();
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: 'Кнопка "Применить" не найдена' });
        }
        return true;
      }

      case 'RUNEXIS_GO_TO_PAGE': {
        const targetPage = msg.page;
        const paginationLinks = document.querySelectorAll('.pagination a, .pager a, nav a[href*="page"]');
        let found = false;

        for (const link of paginationLinks) {
          if (link.textContent.trim() === String(targetPage)) {
            link.click();
            found = true;
            break;
          }
        }

        if (!found) {
          // Попробуем через data-page или href
          for (const link of paginationLinks) {
            const href = link.getAttribute('href') || '';
            if (href.includes(`page=${targetPage}`) || link.dataset.page === String(targetPage)) {
              link.click();
              found = true;
              break;
            }
          }
        }

        sendResponse({ ok: found, error: found ? null : `Страница ${targetPage} не найдена в пагинации` });
        return true;
      }

      case 'RUNEXIS_GET_PAGINATION_INFO': {
        const pages = getPaginationInfo();
        sendResponse({ ok: true, ...pages });
        return true;
      }

      case 'RUNEXIS_COLLECT_NUMBERS': {
        const numbers = collectNumbers();
        sendResponse({ ok: true, numbers });
        return true;
      }

      default:
        break;
    }
  });

  /**
   * Заполнить фильтры на странице /numbers
   */
  function setFilters(city, numberType, code) {
    // Город — ищем поле ввода с автодополнением или select
    const cityInput = document.querySelector('input[name*="city" i]')
      || document.querySelector('input[name*="город" i]')
      || document.querySelector('input[name*="region" i]')
      || document.querySelector('#city')
      || document.querySelector('input[placeholder*="Город" i]')
      || document.querySelector('input[placeholder*="город" i]');

    if (cityInput) {
      setInputValue(cityInput, city);
      // Дать время autocomplete отреагировать
      setTimeout(() => {
        const suggestions = document.querySelectorAll('.ui-autocomplete li a, .autocomplete-suggestion, .tt-suggestion, .dropdown-item, .ui-menu-item');
        if (suggestions.length > 0) {
          // Ищем точное совпадение или первый подходящий
          let bestMatch = null;
          for (const s of suggestions) {
            const text = s.textContent.trim().toLowerCase();
            if (text === city.toLowerCase() || text.startsWith(city.toLowerCase())) {
              bestMatch = s;
              break;
            }
          }
          if (bestMatch) bestMatch.click();
          else suggestions[0].click();
        }
      }, 500);
    }

    // Тип — "Простой" всегда
    const typeSelect = document.querySelector('select[name*="type" i]')
      || document.querySelector('select[name*="тип" i]')
      || document.querySelector('#type')
      || document.querySelector('select[name*="kind" i]');

    if (typeSelect) {
      const simpleOption = Array.from(typeSelect.options).find(o =>
        o.text.toLowerCase().includes('простой') || o.value.toLowerCase().includes('simple')
      );
      if (simpleOption) {
        typeSelect.value = simpleOption.value;
        typeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    // Код (только для Москвы)
    if (code) {
      const codeInput = document.querySelector('input[name*="code" i]')
        || document.querySelector('input[name*="код" i]')
        || document.querySelector('#code')
        || document.querySelector('input[placeholder*="Код" i]');

      const codeSelect = document.querySelector('select[name*="code" i]')
        || document.querySelector('select[name*="код" i]');

      if (codeSelect) {
        const codeOption = Array.from(codeSelect.options).find(o =>
          o.text.includes(code) || o.value === code
        );
        if (codeOption) {
          codeSelect.value = codeOption.value;
          codeSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } else if (codeInput) {
        setInputValue(codeInput, code);
      }
    }
  }

  /**
   * Собрать все номера со страницы
   */
  function collectNumbers() {
    const numbers = [];
    // Ищем ячейки таблицы или элементы с номерами
    const cells = document.querySelectorAll('td, .number, .phone-number, .did-number, [data-number]');

    for (const cell of cells) {
      const text = cell.textContent.trim();
      // Ищем что-то похожее на телефонный номер (минимум 10 цифр в разных форматах)
      const cleaned = text.replace(/[\s\-\(\)\+]/g, '');
      // Число из 10-11 цифр
      if (/^\d{10,11}$/.test(cleaned)) {
        let num = cleaned;
        // Если 10 цифр — добавляем 7 спереди
        if (num.length === 10) {
          num = '7' + num;
        }
        // Если 11 цифр и начинается с 8 — заменяем на 7
        if (num.length === 11 && num.startsWith('8')) {
          num = '7' + num.substring(1);
        }
        if (!numbers.includes(num)) {
          numbers.push(num);
        }
      }
    }

    // Если номера не нашлись в ячейках, ищем по всему тексту страницы
    if (numbers.length === 0) {
      const bodyText = document.body.innerText;
      // Ищем паттерны: (XXX) XXX-XX-XX, XXX XXX XX XX, и т.д.
      const phoneRe = /(?:\+?[78])?[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}/g;
      let m;
      while ((m = phoneRe.exec(bodyText)) !== null) {
        const cleaned2 = m[0].replace(/[\s\-\(\)\+]/g, '');
        let num = cleaned2;
        if (num.length === 10) num = '7' + num;
        if (num.length === 11 && num.startsWith('8')) num = '7' + num.substring(1);
        if (num.length === 11 && !numbers.includes(num)) {
          numbers.push(num);
        }
      }
    }

    return numbers;
  }

  /**
   * Получить информацию о пагинации
   */
  function getPaginationInfo() {
    const paginationLinks = document.querySelectorAll('.pagination a, .pagination li, .pager a');
    const pages = [];
    for (const link of paginationLinks) {
      const num = parseInt(link.textContent.trim(), 10);
      if (!isNaN(num)) pages.push(num);
    }
    const maxPage = pages.length > 0 ? Math.max(...pages) : 1;
    const activePage = document.querySelector('.pagination .active, .pagination li.active');
    const currentPage = activePage ? parseInt(activePage.textContent.trim(), 10) || 1 : 1;
    return { currentPage, maxPage, pages };
  }

  // Утилиты
  function setInputValue(input, value) {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeInputValueSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // Также через keydown для autocomplete
    input.dispatchEvent(new KeyboardEvent('keydown', { key: value.slice(-1), bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: value.slice(-1), bubbles: true }));
  }

  function findButtonByText(text) {
    const buttons = document.querySelectorAll('button, input[type="submit"], input[type="button"], a.btn');
    for (const btn of buttons) {
      if (btn.textContent.trim().toLowerCase().includes(text.toLowerCase())) {
        return btn;
      }
      if (btn.value && btn.value.toLowerCase().includes(text.toLowerCase())) {
        return btn;
      }
    }
    return null;
  }
})();
