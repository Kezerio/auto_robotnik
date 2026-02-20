/**
 * Content script для Support Script (intra10.office.tlpn/support/support_script/).
 * Заполняет поле номера линии, нажимает кнопки по команде.
 */

(function () {
  'use strict';

  function findLineNumberInput() {
    // Ищем поле с placeholder/label "Введите Номер линии" или аналог
    const inputs = document.querySelectorAll('input[type="text"], input:not([type])');
    for (const input of inputs) {
      const ph = (input.placeholder || '').toLowerCase();
      const label = input.closest('label')?.textContent?.toLowerCase() || '';
      const prevLabel = input.previousElementSibling?.textContent?.toLowerCase() || '';
      const name = (input.name || '').toLowerCase();

      if (
        ph.includes('номер линии') || ph.includes('line number') ||
        label.includes('номер линии') || prevLabel.includes('номер линии') ||
        name.includes('line') || name.includes('liniya')
      ) {
        return input;
      }
    }
    // Fallback: first text input
    return inputs[0] || null;
  }

  function findButton(textPattern) {
    const buttons = document.querySelectorAll('button, input[type="submit"], input[type="button"], a.btn');
    for (const btn of buttons) {
      const text = (btn.textContent || btn.value || '').trim();
      if (textPattern.test(text)) return btn;
    }
    return null;
  }

  function setLineNumber(value) {
    const input = findLineNumberInput();
    if (!input) return { ok: false, error: 'Поле номера линии не найдено' };

    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }

  function clickCreateAtc() {
    const btn = findButton(/создать\s*атс|create\s*atc/i);
    if (!btn) return { ok: false, error: 'Кнопка "Создать АТС" не найдена' };
    btn.click();
    return { ok: true };
  }

  function toggleCallRecording(enable) {
    const checkbox = document.querySelector(
      'input[type="checkbox"][name*="record"], input[type="checkbox"][name*="запись"]'
    );
    if (!checkbox) {
      // Try by label
      const labels = document.querySelectorAll('label');
      for (const label of labels) {
        if (/запись\s*звонков|call\s*record/i.test(label.textContent)) {
          const cb = label.querySelector('input[type="checkbox"]') ||
                     document.getElementById(label.getAttribute('for'));
          if (cb) {
            cb.checked = enable;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true };
          }
        }
      }
      return { ok: false, error: 'Чекбокс записи звонков не найден' };
    }
    checkbox.checked = enable;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'SUPPORT_SET_LINE') {
      sendResponse(setLineNumber(msg.lineNumber));
      return true;
    }
    if (msg.type === 'SUPPORT_CLICK_CREATE_ATC') {
      sendResponse(clickCreateAtc());
      return true;
    }
    if (msg.type === 'SUPPORT_TOGGLE_RECORDING') {
      sendResponse(toggleCallRecording(msg.enable));
      return true;
    }
    if (msg.type === 'PARSE_SUPPORT_SCRIPT') {
      sendResponse({
        ok: true,
        data: {
          source: 'support_script',
          url: window.location.href,
          hasLineInput: !!findLineNumberInput(),
          hasCreateBtn: !!findButton(/создать\s*атс|create\s*atc/i)
        }
      });
      return true;
    }
  });
})();
