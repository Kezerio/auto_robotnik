/**
 * Content script для Runexis DID Trunk — подбор номеров.
 * Домен: did-trunk.runexis.ru
 *
 * Обрабатывает сообщения:
 * - RUNEXIS_CHECK_AUTH — проверка авторизации
 * - RUNEXIS_SET_FILTERS — очистить старые + заполнить фильтры (город, тип, код)
 * - RUNEXIS_APPLY_FILTERS — нажать "Применить"
 * - RUNEXIS_WAIT_FOR_RESULTS — ждать до 30с появления результатов или сообщения "ничего не найдено"
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

      case 'RUNEXIS_WAIT_FOR_RESULTS': {
        const timeout = msg.timeout || 30000;
        waitForResults(timeout).then(result => {
          sendResponse(result);
        });
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
  // Ожидание результатов после "Применить"
  // =============================================

  /**
   * Ждать появления результатов (карточки/строки) или "ничего не найдено"
   * Polls every 500ms, timeout по умолчанию 30с
   */
  function waitForResults(timeout) {
    return new Promise(resolve => {
      const startTime = Date.now();
      const interval = setInterval(() => {
        // Проверяем: есть ли карточки/строки с номерами?
        const hasNumbers = document.querySelectorAll(
          'td, .number, .phone-number, .did-number, [data-number], .card, .item, .result-item, table tbody tr'
        ).length > 0;

        // Проверяем: "ничего не найдено"
        const bodyText = document.body.innerText.toLowerCase();
        const notFound = bodyText.includes('ничего не найдено')
          || bodyText.includes('нет результатов')
          || bodyText.includes('no results')
          || bodyText.includes('не найдено');

        if (hasNumbers || notFound) {
          clearInterval(interval);
          resolve({ ok: true, hasNumbers, notFound });
          return;
        }

        if (Date.now() - startTime > timeout) {
          clearInterval(interval);
          resolve({ ok: false, error: `Не дождался результатов за ${Math.round(timeout / 1000)} секунд`, timedOut: true });
        }
      }, 500);
    });
  }

  // =============================================
  // Фильтры: очистка + установка + верификация
  // =============================================

  async function handleSetFilters(city, numberType, code) {
    const diag = {
      citySet: false, typeSet: false, codeSet: false,
      cityValue: '', typeValue: '', codeValue: '',
      cityVerified: false
    };

    // === Шаг 1: Очистить город (× у select2 тегов) ===
    clearSelect2Field('city', 'region', 'город');
    await delay(300);

    // === Шаг 2: Очистить тип ===
    clearSelect2Field('type', 'тип', 'kind');
    await delay(300);

    // === Шаг 3: Очистить код (на случай если остался от прошлого запуска) ===
    clearSelect2Field('code', 'код');
    clearCodeInput();
    await delay(300);

    // === Шаг 4: Установить город + верификация ===
    diag.citySet = await setCityFilter(city);
    await delay(400);
    diag.cityValue = getSelectedCityText();

    // Верификация: проверяем, что выбран именно нужный город
    if (diag.cityValue && !diag.cityValue.toLowerCase().includes(city.toLowerCase())) {
      // Выбран не тот город — повторяем
      clearSelect2Field('city', 'region', 'город');
      await delay(400);
      diag.citySet = await setCityFilter(city);
      await delay(400);
      diag.cityValue = getSelectedCityText();
    }
    diag.cityVerified = diag.cityValue.toLowerCase().includes(city.toLowerCase());

    // === Шаг 5: Тип = "Простой" ===
    diag.typeSet = await setTypeFilter();
    await delay(200);
    diag.typeValue = getSelectedTypeText();

    // === Шаг 6: Код — ТОЛЬКО для Москвы, иначе гарантированно пусто ===
    if (code) {
      diag.codeSet = setCodeFilter(code);
      diag.codeValue = code;
    }
    // Для не-Москвы код уже очищен в шаге 3

    return { ok: true, diagnostics: diag };
  }

  // =============================================
  // Целевая очистка одного select2-поля по паттернам имени
  // =============================================

  /**
   * Очистить конкретное select2 поле: найти его × кнопку и кликнуть,
   * затем обнулить через jQuery API
   */
  function clearSelect2Field(...namePatterns) {
    const s2 = findSelect2For(...namePatterns);
    if (s2) {
      // Кликаем × в rendered-области этого конкретного select2
      const clearBtns = s2.container.querySelectorAll('.select2-selection__clear');
      clearBtns.forEach(btn => { try { btn.click(); } catch (e) {} });

      // Удаляем теги (.select2-selection__choice) если это multiple
      const tags = s2.container.querySelectorAll('.select2-selection__choice__remove');
      tags.forEach(btn => { try { btn.click(); } catch (e) {} });

      // Через jQuery API
      const selId = s2.select.id;
      const selName = s2.select.name;
      const jsSelector = selId ? '#' + selId : 'select[name="' + selName + '"]';
      runInPage(`
        if (typeof jQuery !== 'undefined' && jQuery.fn && jQuery.fn.select2) {
          var $s = jQuery('${jsSelector}');
          if ($s.length && $s.data('select2')) { $s.val(null).trigger('change'); }
        }
      `);
      return;
    }

    // Обычный select
    const selectors = namePatterns.map(p => `select[name*="${p}" i]`).join(', ');
    document.querySelectorAll(selectors).forEach(sel => {
      sel.selectedIndex = 0;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Обычный input
    const inputSelectors = namePatterns.map(p => `input[name*="${p}" i]`).join(', ');
    document.querySelectorAll(inputSelectors).forEach(input => {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  /**
   * Явная очистка input-поля кода (на случай если code — это input, а не select)
   */
  function clearCodeInput() {
    const codeInput = document.querySelector('input[name*="code" i]')
      || document.querySelector('input[name*="код" i]')
      || document.querySelector('#code')
      || document.querySelector('input[placeholder*="Код" i]');
    if (codeInput) {
      codeInput.value = '';
      codeInput.dispatchEvent(new Event('input', { bubbles: true }));
      codeInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
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
   * Установить значение через select2: открыть дропдаун, ввести текст в поиск,
   * дождаться AJAX-подсказок, КЛИКНУТЬ по нужной строке в списке.
   * Никаких val().trigger('change') — только реальный клик по DOM-элементу.
   */
  async function setSelect2Value(ctx, searchText) {
    const jsSelector = buildJsSelector(ctx);

    // 1. Открываем дропдаун
    await openSelect2Dropdown(ctx, jsSelector);
    await delay(300);

    // 2. Находим поле поиска
    let searchField = document.querySelector('.select2-search__field')
      || document.querySelector('.select2-search input');

    if (!searchField) {
      // Попробуем кликнуть по контейнеру
      const selection = ctx.container.querySelector('.select2-selection');
      if (selection) {
        selection.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        selection.click();
        await delay(300);
        searchField = document.querySelector('.select2-search__field')
          || document.querySelector('.select2-search input');
      }
    }

    if (!searchField) return false;

    // 3. Вводим текст посимвольно (для AJAX-автодополнения)
    searchField.value = '';
    searchField.focus();
    for (let i = 0; i < searchText.length; i++) {
      searchField.value = searchText.substring(0, i + 1);
      searchField.dispatchEvent(new Event('input', { bubbles: true }));
      searchField.dispatchEvent(new KeyboardEvent('keyup', { key: searchText[i], bubbles: true }));
    }

    // 4. Ждём загрузки AJAX-результатов
    await delay(1500);

    // 5. Кликаем по ТОЧНО подходящей строке в dropdown
    return clickSelect2Option(searchText);
  }

  /**
   * Открыть select2 через jQuery API (без ввода текста)
   */
  async function openSelect2Dropdown(ctx, jsSelector) {
    runInPage(`
      if (typeof jQuery !== 'undefined' && jQuery.fn.select2) {
        var $s = jQuery('${jsSelector}');
        if ($s.length && $s.data('select2')) { $s.select2('open'); }
      }
    `);
  }

  /**
   * Выбрать пункт в открытом select2-dropdown кликом.
   * Приоритет: точное совпадение → начинается с → содержит.
   * Если ничего не нашли — НЕ кликаем первый попавшийся.
   */
  function clickSelect2Option(searchText) {
    const results = document.querySelectorAll(
      '.select2-results__option:not(.select2-results__option--disabled):not(.loading-results)'
    );
    const lower = searchText.toLowerCase();

    // Приоритет 1: точное совпадение
    for (const r of results) {
      if (r.textContent.trim().toLowerCase() === lower) { r.click(); return true; }
    }
    // Приоритет 2: начинается с
    for (const r of results) {
      if (r.textContent.trim().toLowerCase().startsWith(lower)) { r.click(); return true; }
    }
    // Приоритет 3: содержит
    for (const r of results) {
      if (r.textContent.trim().toLowerCase().includes(lower)) { r.click(); return true; }
    }
    return false;
  }

  function buildJsSelector(ctx) {
    return ctx.select.id ? '#' + ctx.select.id : 'select[name="' + ctx.select.name + '"]';
  }

  function findCityInput() {
    return document.querySelector('input[name*="city" i]')
      || document.querySelector('input[name*="город" i]')
      || document.querySelector('input[name*="region" i]')
      || document.querySelector('#city')
      || document.querySelector('input[placeholder*="Город" i]')
      || document.querySelector('input[placeholder*="город" i]');
  }

  async function setInputWithAutocomplete(input, text) {
    input.focus();
    input.click();
    input.value = '';

    for (let i = 0; i < text.length; i++) {
      input.value = text.substring(0, i + 1);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: text[i], bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: text[i], bubbles: true }));
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));

    await delay(800);

    const suggestions = document.querySelectorAll(
      '.ui-autocomplete li a, .ui-autocomplete .ui-menu-item, ' +
      '.autocomplete-suggestion, .tt-suggestion, .dropdown-item, .dropdown-menu li a'
    );
    if (suggestions.length > 0) {
      // Приоритет: точное → начинается → содержит. НЕ кликаем первый попавшийся.
      for (const s of suggestions) {
        if (s.textContent.trim().toLowerCase() === text.toLowerCase()) { s.click(); return true; }
      }
      for (const s of suggestions) {
        if (s.textContent.trim().toLowerCase().startsWith(text.toLowerCase())) { s.click(); return true; }
      }
      for (const s of suggestions) {
        if (s.textContent.trim().toLowerCase().includes(text.toLowerCase())) { s.click(); return true; }
      }
    }

    return true;
  }

  function setPlainSelectByText(sel, text) {
    // Точное совпадение сначала
    const exactOpt = Array.from(sel.options).find(o =>
      o.text.trim().toLowerCase() === text.toLowerCase()
    );
    if (exactOpt) {
      sel.value = exactOpt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    // Начинается с
    const startOpt = Array.from(sel.options).find(o =>
      o.text.trim().toLowerCase().startsWith(text.toLowerCase())
    );
    if (startOpt) {
      sel.value = startOpt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  }

  // =============================================
  // Тип номера: очистить + установить "Простой"
  // =============================================

  /**
   * Тип: открыть dropdown, КЛИКНУТЬ по "Простой" в списке.
   * НЕ вводить текст, НЕ жать Enter — только клик по строке.
   */
  async function setTypeFilter() {
    // select2
    const s2 = findSelect2For('type', 'тип', 'kind');
    if (s2) {
      const jsSelector = buildJsSelector(s2);

      // Открываем дропдаун
      await openSelect2Dropdown(s2, jsSelector);
      await delay(400);

      // Кликаем по пункту "Простой" в открытом списке
      const clicked = clickSelect2Option('Простой');
      if (clicked) return true;

      // Если не нашли в dropdown — попробуем через поиск
      const searchField = document.querySelector('.select2-search__field');
      if (searchField) {
        searchField.value = 'Простой';
        searchField.dispatchEvent(new Event('input', { bubbles: true }));
        await delay(500);
        const clicked2 = clickSelect2Option('Простой');
        if (clicked2) return true;
      }

      // Закрываем
      runInPage(`
        if (typeof jQuery !== 'undefined' && jQuery.fn.select2) {
          try { jQuery('${jsSelector}').select2('close'); } catch(e) {}
        }
      `);
      return false;
    }

    // Обычный select (без select2)
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
    const s2 = findSelect2For('code', 'код');
    if (s2) {
      const selId = s2.select.id;
      const selName = s2.select.name;
      const jsSelector = selId ? '#' + selId : 'select[name="' + selName + '"]';
      const opt = Array.from(s2.select.options).find(o =>
        o.text.includes(code) || o.value === code
      );
      if (opt) {
        runInPage(`
          if (typeof jQuery !== 'undefined' && jQuery.fn.select2) {
            var $s = jQuery('${jsSelector}');
            if ($s.length) { $s.val('${opt.value}').trigger('change'); }
          }
        `);
        return true;
      }
    }

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
    // select2 теги (множественный выбор)
    const tags = document.querySelectorAll('.select2-selection__choice');
    if (tags.length > 0) {
      return Array.from(tags).map(t => {
        // Убираем текст кнопки × из тега
        const clone = t.cloneNode(true);
        const removeBtn = clone.querySelector('.select2-selection__choice__remove');
        if (removeBtn) removeBtn.remove();
        return clone.textContent.trim();
      }).join(', ');
    }
    // select2 rendered text (одиночный выбор)
    const rendered = document.querySelector('.select2-selection__rendered');
    if (rendered && rendered.textContent.trim() && rendered.textContent.trim() !== '—') {
      return rendered.textContent.trim();
    }
    const input = findCityInput();
    if (input) return input.value;
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

  function runInPage(code) {
    const script = document.createElement('script');
    script.textContent = `(function(){${code}})();`;
    document.documentElement.appendChild(script);
    script.remove();
  }
})();
