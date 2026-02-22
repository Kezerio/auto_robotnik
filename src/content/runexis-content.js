/**
 * Content script для Runexis DID Trunk — подбор номеров.
 * Домен: did-trunk.runexis.ru
 *
 * Обрабатывает сообщения:
 * - RUNEXIS_CHECK_AUTH — проверка авторизации
 * - RUNEXIS_SET_FILTERS — очистить старые + заполнить фильтры (город, тип, код)
 * - RUNEXIS_APPLY_FILTERS — нажать "Применить"
 * - RUNEXIS_GO_TO_PAGE — перейти на нужную страницу пагинации
 * - RUNEXIS_COLLECT_NUMBERS — собрать номера со страницы
 * - RUNEXIS_COPY_TO_CLIPBOARD — скопировать текст (от имени этой вкладки)
 */
(function () {
  'use strict';

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'RUNEXIS_CHECK_AUTH': {
        const isLoginPage = window.location.pathname.includes('/site/login')
          || !!document.querySelector('form#login-form')
          || !!document.querySelector('input[name="LoginForm[username]"]');
        const isNumbersPage = window.location.pathname.includes('/numbers');
        sendResponse({ ok: true, isLoginPage, isNumbersPage, url: window.location.href });
        return true;
      }

      case 'RUNEXIS_SET_FILTERS': {
        const { city, numberType, code } = msg;
        handleSetFilters(city, numberType, code).then(result => {
          sendResponse(result);
        }).catch(err => {
          sendResponse({ ok: false, error: err.message });
        });
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

      case 'RUNEXIS_COPY_TO_CLIPBOARD': {
        const text = msg.text || '';
        navigator.clipboard.writeText(text).then(() => {
          sendResponse({ ok: true });
        }).catch(err => {
          // Fallback: execCommand
          try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
            sendResponse({ ok: true, method: 'execCommand' });
          } catch (e2) {
            sendResponse({ ok: false, error: err.message });
          }
        });
        return true;
      }

      default:
        break;
    }
  });

  // =============================================
  // Фильтры: очистка + установка + диагностика
  // =============================================

  async function handleSetFilters(city, numberType, code) {
    const diag = {
      citySet: false, typeSet: false, codeSet: false,
      cityValue: '', typeValue: '', codeValue: ''
    };

    // Шаг 1: Очистить все фильтры
    clearAllFilters();
    await delay(500);

    // Шаг 2: Город (select2, autocomplete или обычный input)
    diag.citySet = await setCityFilter(city);
    await delay(300);
    diag.cityValue = getSelectedCityText();

    // Шаг 3: Тип = "Простой"
    diag.typeSet = setTypeFilter();
    diag.typeValue = getSelectedTypeText();

    // Шаг 4: Код (только Москва)
    if (code) {
      diag.codeSet = setCodeFilter(code);
      diag.codeValue = code;
    }

    return { ok: true, diagnostics: diag };
  }

  /**
   * Очистить все поля фильтров (select2, autocomplete, обычные input/select)
   */
  function clearAllFilters() {
    // 1. Кнопки "×" select2
    document.querySelectorAll('.select2-selection__clear').forEach(btn => {
      try { btn.click(); } catch (e) {}
    });

    // 2. Сброс обычных select
    document.querySelectorAll('select').forEach(sel => {
      if (sel.closest('.select2-container')) return;
      sel.selectedIndex = 0;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // 3. jQuery select2 API через инъекцию в страницу
    runInPage(`
      if (typeof jQuery !== 'undefined' && jQuery.fn && jQuery.fn.select2) {
        jQuery('select').each(function() {
          try {
            var $s = jQuery(this);
            if ($s.data('select2')) { $s.val(null).trigger('change'); }
          } catch(e) {}
        });
      }
    `);

    // 4. Очистка текстовых полей
    document.querySelectorAll(
      'input[type="text"], input[type="search"], input:not([type]):not([name*="csrf" i]):not([name*="token" i])'
    ).forEach(input => {
      if (input.closest('.select2-container')) return;
      if (input.closest('.select2-search')) return;
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  // =============================================
  // Город: select2 / autocomplete / обычный input
  // =============================================

  async function setCityFilter(city) {
    // Метод A: select2 на <select>
    const s2 = findSelect2For('city', 'region', 'город');
    if (s2) {
      return await setSelect2Value(s2, city);
    }

    // Метод B: обычный input с autocomplete
    const cityInput = findCityInput();
    if (cityInput) {
      return await setInputWithAutocomplete(cityInput, city);
    }

    // Метод C: обычный <select> без select2
    const citySelect = document.querySelector('select[name*="city" i]')
      || document.querySelector('select[name*="region" i]')
      || document.querySelector('select#city');
    if (citySelect) {
      return setPlainSelectByText(citySelect, city);
    }

    return false;
  }

  /**
   * Найти select2-enhanced <select> по паттернам имени
   */
  function findSelect2For(...patterns) {
    const selects = document.querySelectorAll('select');
    for (const sel of selects) {
      const name = (sel.name || sel.id || '').toLowerCase();
      if (!patterns.some(p => name.includes(p.toLowerCase()))) continue;
      const next = sel.nextElementSibling;
      if (next && next.classList.contains('select2-container')) {
        return { select: sel, container: next };
      }
    }
    // Поиск через контейнеры select2
    const containers = document.querySelectorAll('.select2-container');
    for (const c of containers) {
      const sel = c.previousElementSibling;
      if (sel && sel.tagName === 'SELECT') {
        const name = (sel.name || sel.id || '').toLowerCase();
        if (patterns.some(p => name.includes(p.toLowerCase()))) {
          return { select: sel, container: c };
        }
      }
    }
    return null;
  }

  /**
   * Установить значение через select2 API (открыть дропдаун, ввести текст, выбрать)
   */
  async function setSelect2Value(ctx, searchText) {
    const selId = ctx.select.id;
    const selName = ctx.select.name;
    const jsSelector = selId ? '#' + selId : 'select[name="' + selName + '"]';

    // Открываем дропдаун через jQuery API
    runInPage(`
      if (typeof jQuery !== 'undefined' && jQuery.fn.select2) {
        var $s = jQuery('${jsSelector}');
        if ($s.length && $s.data('select2')) { $s.select2('open'); }
      }
    `);
    await delay(300);

    // Ищем поле поиска select2
    let searchField = document.querySelector('.select2-search__field')
      || document.querySelector('.select2-search input');

    // Запасной вариант: кликаем по контейнеру select2
    if (!searchField) {
      const selection = ctx.container.querySelector('.select2-selection');
      if (selection) {
        selection.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        selection.click();
        await delay(300);
        searchField = document.querySelector('.select2-search__field')
          || document.querySelector('.select2-search input');
      }
    }

    if (searchField) {
      searchField.value = '';
      searchField.focus();

      // Вводим посимвольно для AJAX-автодополнения
      for (let i = 0; i < searchText.length; i++) {
        searchField.value = searchText.substring(0, i + 1);
        searchField.dispatchEvent(new Event('input', { bubbles: true }));
        searchField.dispatchEvent(new KeyboardEvent('keyup', { key: searchText[i], bubbles: true }));
      }

      // Ждём загрузку результатов (AJAX)
      await delay(1000);

      // Кликаем подходящий результат
      const results = document.querySelectorAll(
        '.select2-results__option:not(.select2-results__option--disabled):not(.loading-results)'
      );
      for (const r of results) {
        const text = r.textContent.trim().toLowerCase();
        if (text === searchText.toLowerCase() || text.startsWith(searchText.toLowerCase())) {
          r.click();
          return true;
        }
      }
      // Fallback: первый результат
      if (results.length > 0) {
        results[0].click();
        return true;
      }
    }

    // Последняя попытка: через jQuery option matching
    runInPage(`
      if (typeof jQuery !== 'undefined' && jQuery.fn.select2) {
        var $s = jQuery('${jsSelector}');
        if ($s.length) {
          var opts = $s.find('option');
          opts.each(function() {
            if (this.textContent.trim().toLowerCase().indexOf('${searchText.toLowerCase()}') >= 0) {
              $s.val(this.value).trigger('change');
              return false;
            }
          });
          try { $s.select2('close'); } catch(e) {}
        }
      }
    `);
    await delay(300);
    return true;
  }

  /**
   * Найти input для города
   */
  function findCityInput() {
    return document.querySelector('input[name*="city" i]')
      || document.querySelector('input[name*="город" i]')
      || document.querySelector('input[name*="region" i]')
      || document.querySelector('#city')
      || document.querySelector('input[placeholder*="Город" i]')
      || document.querySelector('input[placeholder*="город" i]');
  }

  /**
   * Установить значение в input с ожиданием autocomplete
   */
  async function setInputWithAutocomplete(input, text) {
    input.focus();
    input.click();
    input.value = '';

    // Вводим посимвольно
    for (let i = 0; i < text.length; i++) {
      input.value = text.substring(0, i + 1);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: text[i], bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: text[i], bubbles: true }));
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));

    // Ждём autocomplete
    await delay(800);

    // Ищем dropdown
    const suggestions = document.querySelectorAll(
      '.ui-autocomplete li a, .ui-autocomplete .ui-menu-item, ' +
      '.autocomplete-suggestion, .tt-suggestion, .dropdown-item, .dropdown-menu li a'
    );
    if (suggestions.length > 0) {
      let bestMatch = null;
      for (const s of suggestions) {
        const st = s.textContent.trim().toLowerCase();
        if (st === text.toLowerCase() || st.startsWith(text.toLowerCase())) {
          bestMatch = s;
          break;
        }
      }
      (bestMatch || suggestions[0]).click();
      return true;
    }

    // Нет suggestions — value уже установлен
    return true;
  }

  /**
   * Установить опцию в обычном <select> по тексту
   */
  function setPlainSelectByText(sel, text) {
    const opt = Array.from(sel.options).find(o =>
      o.text.trim().toLowerCase().includes(text.toLowerCase())
    );
    if (opt) {
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  }

  // =============================================
  // Тип номера: "Простой"
  // =============================================

  function setTypeFilter() {
    // select2
    const s2 = findSelect2For('type', 'тип', 'kind');
    if (s2) {
      const opt = Array.from(s2.select.options).find(o =>
        o.text.toLowerCase().includes('простой') || o.value.toLowerCase().includes('simple')
      );
      if (opt) {
        runInPage(`
          if (typeof jQuery !== 'undefined' && jQuery.fn.select2) {
            var $s = jQuery('${s2.select.id ? '#' + s2.select.id : 'select[name="' + s2.select.name + '"]'}');
            if ($s.length) { $s.val('${opt.value}').trigger('change'); }
          }
        `);
        return true;
      }
    }

    // Обычный select
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
        return true;
      }
    }
    return false;
  }

  // =============================================
  // Код (только для Москвы)
  // =============================================

  function setCodeFilter(code) {
    // select2
    const s2 = findSelect2For('code', 'код');
    if (s2) {
      const opt = Array.from(s2.select.options).find(o =>
        o.text.includes(code) || o.value === code
      );
      if (opt) {
        runInPage(`
          if (typeof jQuery !== 'undefined' && jQuery.fn.select2) {
            var $s = jQuery('${s2.select.id ? '#' + s2.select.id : 'select[name="' + s2.select.name + '"]'}');
            if ($s.length) { $s.val('${opt.value}').trigger('change'); }
          }
        `);
        return true;
      }
    }

    // Обычный select
    const codeSelect = document.querySelector('select[name*="code" i]')
      || document.querySelector('select[name*="код" i]');
    if (codeSelect) {
      const codeOption = Array.from(codeSelect.options).find(o =>
        o.text.includes(code) || o.value === code
      );
      if (codeOption) {
        codeSelect.value = codeOption.value;
        codeSelect.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }

    // Input
    const codeInput = document.querySelector('input[name*="code" i]')
      || document.querySelector('input[name*="код" i]')
      || document.querySelector('#code')
      || document.querySelector('input[placeholder*="Код" i]');
    if (codeInput) {
      setInputValue(codeInput, code);
      return true;
    }

    return false;
  }

  // =============================================
  // Диагностика: чтение текущих значений
  // =============================================

  function getSelectedCityText() {
    // select2 rendered text
    const rendered = document.querySelector('.select2-selection__rendered');
    if (rendered && rendered.textContent.trim() && rendered.textContent.trim() !== '—') {
      return rendered.textContent.trim();
    }
    // Обычный input
    const input = findCityInput();
    if (input) return input.value;
    // Select
    const sel = document.querySelector('select[name*="city" i]') || document.querySelector('select#city');
    if (sel && sel.selectedIndex > 0) return sel.options[sel.selectedIndex].text;
    return '';
  }

  function getSelectedTypeText() {
    const sel = document.querySelector('select[name*="type" i]')
      || document.querySelector('select[name*="тип" i]')
      || document.querySelector('#type');
    if (sel && sel.selectedIndex >= 0) return sel.options[sel.selectedIndex].text;
    return '';
  }

  // =============================================
  // Сбор номеров
  // =============================================

  function collectNumbers() {
    const numbers = [];
    const cells = document.querySelectorAll('td, .number, .phone-number, .did-number, [data-number]');

    for (const cell of cells) {
      const text = cell.textContent.trim();
      const cleaned = text.replace(/[\s\-\(\)\+]/g, '');
      if (/^\d{10,11}$/.test(cleaned)) {
        let num = cleaned;
        if (num.length === 10) num = '7' + num;
        if (num.length === 11 && num.startsWith('8')) num = '7' + num.substring(1);
        if (!numbers.includes(num)) numbers.push(num);
      }
    }

    if (numbers.length === 0) {
      const bodyText = document.body.innerText;
      const phoneRe = /(?:\+?[78])?[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}/g;
      let m;
      while ((m = phoneRe.exec(bodyText)) !== null) {
        const cleaned2 = m[0].replace(/[\s\-\(\)\+]/g, '');
        let num = cleaned2;
        if (num.length === 10) num = '7' + num;
        if (num.length === 11 && num.startsWith('8')) num = '7' + num.substring(1);
        if (num.length === 11 && !numbers.includes(num)) numbers.push(num);
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

  // =============================================
  // Утилиты
  // =============================================

  function setInputValue(input, value) {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeInputValueSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: value.slice(-1), bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: value.slice(-1), bubbles: true }));
  }

  function findButtonByText(text) {
    const buttons = document.querySelectorAll('button, input[type="submit"], input[type="button"], a.btn');
    for (const btn of buttons) {
      if (btn.textContent.trim().toLowerCase().includes(text.toLowerCase())) return btn;
      if (btn.value && btn.value.toLowerCase().includes(text.toLowerCase())) return btn;
    }
    return null;
  }

  /**
   * Запуск кода в контексте страницы (для доступа к jQuery/select2)
   */
  function runInPage(code) {
    const script = document.createElement('script');
    script.textContent = `(function(){${code}})();`;
    document.documentElement.appendChild(script);
    script.remove();
  }
})();
