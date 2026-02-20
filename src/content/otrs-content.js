/**
 * Content script для OTRS AgentTicketZoom.
 * Извлекает: TicketID, clientCode, lineNumber, atcPlan, доп. данные.
 */

(function () {
  'use strict';

  const CLIENT_CODE_RE = /([A-Z]{3}\d{5})(?:_(\d+)(?:\((\d+)\))?)?/g;
  const LINE_NUMBER_RE = /(?:линия|line)\s*(?:номер|number|#|№)?\s*[:=]?\s*(\d{6,12})/gi;
  const ATC_PLAN_RE = /\b(Start|Business)\b/gi;

  function getTicketIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('TicketID') || '';
  }

  function parseClientCodeFull(text) {
    const results = [];
    let m;
    CLIENT_CODE_RE.lastIndex = 0;
    while ((m = CLIENT_CODE_RE.exec(text)) !== null) {
      results.push({
        full: m[0],
        clientCode: m[1],
        suffix: m[2] || '',
        extra: m[3] || ''
      });
    }
    return results;
  }

  function extractFromSidebar() {
    const data = { clientCode: '', accountingUrl: '', sidebarRaw: {} };

    // Правая панель OTRS — ищем поля "Телфин.Офис" и "Аккаунтинг"
    const sidebarItems = document.querySelectorAll(
      '.SidebarColumn .WidgetSimple .Content table tr, ' +
      '.SidebarColumn .WidgetSimple .Content .Value, ' +
      '#DynamicFieldWrapper .Row .Value, ' +
      '.TableLike .Value'
    );

    sidebarItems.forEach(el => {
      const text = el.textContent.trim();
      // Check parent label
      const label = el.previousElementSibling?.textContent?.trim() || '';
      const row = el.closest('tr');
      const labelCell = row?.querySelector('td:first-child, th:first-child');
      const labelText = labelCell?.textContent?.trim() || label;

      if (/телфин[\.\s]*офис/i.test(labelText)) {
        const codes = parseClientCodeFull(text);
        if (codes.length > 0) {
          data.clientCode = codes[0].clientCode;
          data.sidebarRaw['telphinOffice'] = codes[0];
        }
      }
      if (/аккаунтинг/i.test(labelText)) {
        const link = el.querySelector('a') || (row && row.querySelector('a'));
        if (link) {
          data.accountingUrl = link.href;
        }
      }
    });

    // Fallback: ищем в CustomerID или CustomerUserID
    if (!data.clientCode) {
      const customerEl = document.querySelector(
        '#CustomerID, .CustomerID, [data-name="CustomerID"]'
      );
      if (customerEl) {
        const codes = parseClientCodeFull(customerEl.textContent);
        if (codes.length > 0) data.clientCode = codes[0].clientCode;
      }
    }

    return data;
  }

  function extractFromBody() {
    const data = { lineNumbers: [], atcPlans: [], clientCodes: [], bodyText: '' };

    // Тело тикета — все статьи
    const articles = document.querySelectorAll(
      '.ArticleBody, .ArticleMailContent, #ArticleItems .Content, .MessageBody'
    );

    let fullText = '';
    articles.forEach(el => {
      fullText += ' ' + el.textContent;
    });
    data.bodyText = fullText.substring(0, 5000);

    // lineNumber
    let m;
    LINE_NUMBER_RE.lastIndex = 0;
    while ((m = LINE_NUMBER_RE.exec(fullText)) !== null) {
      if (!data.lineNumbers.includes(m[1])) {
        data.lineNumbers.push(m[1]);
      }
    }

    // atcPlan
    ATC_PLAN_RE.lastIndex = 0;
    while ((m = ATC_PLAN_RE.exec(fullText)) !== null) {
      const plan = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
      if (!data.atcPlans.includes(plan)) {
        data.atcPlans.push(plan);
      }
    }

    // clientCodes
    data.clientCodes = parseClientCodeFull(fullText);

    return data;
  }

  function collectTicketData() {
    const ticketId = getTicketIdFromUrl();
    const sidebar = extractFromSidebar();
    const body = extractFromBody();

    // Merge clientCode: sidebar > body
    let clientCode = sidebar.clientCode;
    if (!clientCode && body.clientCodes.length > 0) {
      clientCode = body.clientCodes[0].clientCode;
    }

    return {
      source: 'otrs',
      url: window.location.href,
      ticketId,
      clientCode,
      clientCodeFull: body.clientCodes[0] || null,
      lineNumbers: body.lineNumbers,
      atcPlan: body.atcPlans[0] || '',
      accountingUrl: sidebar.accountingUrl,
      sidebarRaw: sidebar.sidebarRaw,
      bodyExcerpt: body.bodyText.substring(0, 2000)
    };
  }

  // === Вставка шаблона в редактор ответа ===
  function insertTemplate(text) {
    // 1) CKEditor API (OTRS часто использует CKEditor)
    if (typeof CKEDITOR !== 'undefined') {
      const editors = Object.values(CKEDITOR.instances || {});
      if (editors.length > 0) {
        const html = text.replace(/\n/g, '<br>');
        editors[0].insertHtml(html);
        return { ok: true };
      }
    }

    // 2) WYSIWYG iframe
    const editorIframe = document.querySelector(
      '#cke_1_contents iframe, .cke_wysiwyg_frame, ' +
      '#RichText iframe, .RichTextEditor iframe'
    );
    if (editorIframe) {
      try {
        const editorDoc = editorIframe.contentDocument || editorIframe.contentWindow.document;
        const body = editorDoc.querySelector('body');
        if (body) {
          const html = text.replace(/\n/g, '<br>');
          body.innerHTML = html + body.innerHTML;
          return { ok: true };
        }
      } catch (_) { /* cross-origin */ }
    }

    // 3) Textarea fallback
    const textarea = document.querySelector(
      '#RichText, textarea[name="Body"], textarea[name="RichText"], #Body'
    );
    if (textarea) {
      textarea.value = text + '\n' + textarea.value;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    }

    return { ok: false, error: 'Редактор ответа не найден на странице' };
  }

  // Слушаем запросы от background/UI
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'PARSE_OTRS') {
      try {
        const data = collectTicketData();
        sendResponse({ ok: true, data });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return true;
    }

    if (msg.type === 'OTRS_POSTPONE_14') {
      try {
        performPostpone14();
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return true;
    }

    if (msg.type === 'OTRS_MOVE_QUEUE') {
      try {
        moveToQueue(msg.queue);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return true;
    }

    if (msg.type === 'INSERT_TEMPLATE') {
      try {
        const result = insertTemplate(msg.text);
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return true;
    }
  });

  // Отложить на 14 дней — через интерфейс OTRS
  function performPostpone14() {
    // Пункт меню "Переместить" — выбрать очередь 14day
    const moveSelect = document.querySelector(
      '#DestQueueID, select[name="DestQueueID"]'
    );
    if (moveSelect) {
      const option = Array.from(moveSelect.options).find(o =>
        /14day/i.test(o.text) || /14day/i.test(o.value)
      );
      if (option) {
        moveSelect.value = option.value;
        moveSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }

  function moveToQueue(queueName) {
    const moveSelect = document.querySelector(
      '#DestQueueID, select[name="DestQueueID"]'
    );
    if (moveSelect) {
      const option = Array.from(moveSelect.options).find(o =>
        o.text.includes(queueName) || o.value.includes(queueName)
      );
      if (option) {
        moveSelect.value = option.value;
        moveSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }

  // Автоматически отправить данные при загрузке (для side panel)
  if (window.location.href.includes('AgentTicketZoom')) {
    setTimeout(() => {
      const data = collectTicketData();
      chrome.runtime.sendMessage({ type: 'OTRS_DATA_READY', data });
    }, 1000);
  }
})();
