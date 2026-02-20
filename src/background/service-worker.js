/**
 * Background service worker — оркестрация.
 * Обрабатывает сообщения от content scripts и side panel.
 */

import { addLog } from '../storage/logger.js';

// Открыть side panel при клике на иконку
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Хранение текущего состояния
const state = {
  ticketData: null,
  accountingData: null,
  ringmeData: null,
  teleoData: null,
  recording: false,
  recordedSteps: [],
  mode: 'assist'  // 'assist' | 'automate'
};

// Обработка сообщений
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    // === Данные от content scripts ===
    case 'OTRS_DATA_READY':
      state.ticketData = msg.data;
      broadcastToSidePanel({ type: 'STATE_UPDATE', key: 'ticketData', data: msg.data });
      addLog('OTRS', 'Данные тикета получены', true);
      break;

    case 'ACCOUNTING_DATA_READY':
      state.accountingData = msg.data;
      broadcastToSidePanel({ type: 'STATE_UPDATE', key: 'accountingData', data: msg.data });
      addLog('Accounting', 'Данные аккаунтинга получены', true);
      break;

    case 'RINGME_DATA_READY':
      state.ringmeData = msg.data;
      broadcastToSidePanel({ type: 'STATE_UPDATE', key: 'ringmeData', data: msg.data });
      addLog('Ringme', 'Данные Ringme получены', true);
      break;

    case 'TELEO_DATA_READY':
      state.teleoData = msg.data;
      broadcastToSidePanel({ type: 'STATE_UPDATE', key: 'teleoData', data: msg.data });
      addLog('Teleo', 'Данные Teleo получены', true);
      break;

    case 'LOGIN_REQUIRED':
      broadcastToSidePanel({ type: 'LOGIN_REQUIRED', data: msg.data });
      addLog(msg.data.system, 'Требуется авторизация', false, 'Пользователь должен войти вручную');
      break;

    // === Recorder ===
    case 'RECORDER_STEP':
      if (state.recording) {
        state.recordedSteps.push(msg.step);
        broadcastToSidePanel({ type: 'RECORDER_STEP_ADDED', step: msg.step, total: state.recordedSteps.length });
        addLog('Recorder', `Шаг записан: ${msg.step.action} на ${msg.step.selector}`, true);
      }
      break;

    // === Команды от side panel ===
    case 'GET_STATE':
      sendResponse({ ok: true, state });
      return true;

    case 'SET_MODE':
      state.mode = msg.mode;
      addLog('System', `Режим изменён на: ${msg.mode}`, true);
      sendResponse({ ok: true });
      return true;

    case 'OPEN_TAB': {
      chrome.tabs.create({ url: msg.url, active: msg.activate !== false }, tab => {
        sendResponse({ ok: true, tabId: tab.id });
      });
      return true;
    }

    case 'FIND_TAB': {
      chrome.tabs.query({}, tabs => {
        const found = tabs.find(t => t.url && t.url.includes(msg.urlPattern));
        sendResponse({ ok: true, tabId: found?.id || null });
      });
      return true;
    }

    case 'SEND_TO_TAB': {
      chrome.tabs.sendMessage(msg.tabId, msg.message, resp => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse(resp);
        }
      });
      return true;
    }

    case 'START_RECORDING': {
      state.recording = true;
      state.recordedSteps = [];
      // Отправляем команду текущей вкладке
      chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        if (tab) {
          chrome.tabs.sendMessage(tab.id, { type: 'START_RECORDING' });
        }
      });
      addLog('Recorder', 'Запись начата', true);
      sendResponse({ ok: true });
      return true;
    }

    case 'STOP_RECORDING': {
      state.recording = false;
      chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        if (tab) {
          chrome.tabs.sendMessage(tab.id, { type: 'STOP_RECORDING' });
        }
      });
      addLog('Recorder', `Запись завершена, ${state.recordedSteps.length} шагов`, true);
      sendResponse({ ok: true, steps: state.recordedSteps });
      return true;
    }

    case 'GET_RECORDED_STEPS':
      sendResponse({ ok: true, steps: state.recordedSteps });
      return true;

    case 'EXECUTE_ON_TAB': {
      chrome.tabs.sendMessage(msg.tabId, msg.message, resp => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse(resp);
        }
      });
      return true;
    }

    case 'PARSE_ACTIVE_TAB': {
      chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        if (!tab) {
          sendResponse({ ok: false, error: 'Нет активной вкладки' });
          return;
        }
        chrome.tabs.sendMessage(tab.id, { type: msg.parseType }, resp => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            sendResponse(resp);
          }
        });
      });
      return true;
    }

    default:
      break;
  }
});

function broadcastToSidePanel(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {
    // Side panel may not be open — ignore
  });
}

// Инжектируем recorder content script при переключении вкладок в режиме записи
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (state.recording) {
    try {
      const tab = await chrome.tabs.get(activeInfo.tabId);
      if (tab.url && isAllowedUrl(tab.url)) {
        chrome.tabs.sendMessage(activeInfo.tabId, { type: 'START_RECORDING' }).catch(() => {});
      }
    } catch (_) {}
  }
});

function isAllowedUrl(url) {
  const patterns = [
    'otrs.tlpn',
    'intra10.office.tlpn',
    'ringmeadmin.tlpn',
    'apiproxy.telphin.ru',
    'teleo.telphin.ru'
  ];
  return patterns.some(p => url.includes(p));
}
