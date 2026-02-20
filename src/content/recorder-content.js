/**
 * Recorder content script — element picker и запись действий.
 * Инжектируется на все поддерживаемые домены.
 */

(function () {
  'use strict';

  let isRecording = false;
  let hoveredEl = null;
  let overlay = null;

  function createOverlay() {
    overlay = document.createElement('div');
    overlay.id = 'robotnik-recorder-overlay';
    overlay.style.cssText = `
      position: fixed; pointer-events: none; z-index: 999999;
      border: 2px solid #ff4444; background: rgba(255, 68, 68, 0.1);
      transition: all 0.1s ease; display: none;
    `;
    document.body.appendChild(overlay);
  }

  function removeOverlay() {
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
  }

  function getStableSelector(el) {
    // Приоритет: id > name > data-attr > nth-child path
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;

    // data attributes
    for (const attr of el.attributes) {
      if (attr.name.startsWith('data-') && attr.value) {
        return `${el.tagName.toLowerCase()}[${attr.name}="${CSS.escape(attr.value)}"]`;
      }
    }

    // Build path
    const path = [];
    let current = el;
    while (current && current !== document.body) {
      let selector = current.tagName.toLowerCase();
      if (current.id) {
        selector = `#${CSS.escape(current.id)}`;
        path.unshift(selector);
        break;
      }
      if (current.className && typeof current.className === 'string') {
        const classes = current.className.trim().split(/\s+/).slice(0, 2);
        if (classes.length > 0 && classes[0]) {
          selector += '.' + classes.map(c => CSS.escape(c)).join('.');
        }
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          c => c.tagName === current.tagName
        );
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          selector += `:nth-of-type(${index})`;
        }
      }
      path.unshift(selector);
      current = current.parentElement;
    }
    return path.join(' > ');
  }

  function detectActionType(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      const type = (el.type || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return 'check';
      return 'input';
    }
    if (tag === 'select') return 'select';
    if (tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button') return 'click';
    return 'click';
  }

  function onMouseMove(e) {
    if (!isRecording || !overlay) return;
    hoveredEl = e.target;
    const rect = hoveredEl.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.top = rect.top + 'px';
    overlay.style.left = rect.left + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
  }

  function onClick(e) {
    if (!isRecording) return;
    e.preventDefault();
    e.stopPropagation();

    const el = e.target;
    const step = {
      selector: getStableSelector(el),
      action: detectActionType(el),
      tagName: el.tagName.toLowerCase(),
      text: (el.textContent || '').trim().substring(0, 100),
      value: el.value || '',
      placeholder: el.placeholder || '',
      url: window.location.href,
      timestamp: new Date().toISOString()
    };

    chrome.runtime.sendMessage({ type: 'RECORDER_STEP', step });
  }

  function startRecording() {
    if (isRecording) return;
    isRecording = true;
    createOverlay();
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);
  }

  function stopRecording() {
    isRecording = false;
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
    removeOverlay();
  }

  // Replay: выполнить шаг
  async function executeStep(step) {
    const el = document.querySelector(step.selector);
    if (!el) {
      return { ok: false, error: `Элемент не найден: ${step.selector}` };
    }

    switch (step.action) {
      case 'click':
        el.click();
        return { ok: true };
      case 'input':
        el.focus();
        el.value = step.value || '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      case 'select':
        el.value = step.value || '';
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      case 'check':
        el.checked = !el.checked;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      default:
        return { ok: false, error: `Неизвестное действие: ${step.action}` };
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'START_RECORDING') {
      startRecording();
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'STOP_RECORDING') {
      stopRecording();
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'EXECUTE_STEP') {
      executeStep(msg.step).then(sendResponse);
      return true;
    }
    if (msg.type === 'CHECK_SELECTOR') {
      const el = document.querySelector(msg.selector);
      sendResponse({ ok: true, found: !!el, tagName: el?.tagName });
      return true;
    }
  });
})();
