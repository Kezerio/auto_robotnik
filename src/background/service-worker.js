/**
 * Background service worker — оркестрация.
 * Управление окном-консолью, pin/unpin, bind-to-tab, контекст тикета.
 */

import { addLog } from '../storage/logger.js';

// === Window management state ===
let consoleWindowId = null;
let pinned = false;
let boundTabId = null;
let mainBrowserWindowId = null;

const DEFAULT_WINDOW = { width: 480, height: 750, left: 100, top: 100 };

// Хранение текущего состояния данных
const state = {
  ticketData: null,
  accountingData: null,
  ringmeData: null,
  teleoData: null,
  recording: false,
  recordedSteps: [],
  mode: 'assist',
  debugMode: false,
  lastRunexisResult: null // последний результат подбора номеров
};

// Отслеживание вкладок compose/note для вставки шаблонов
let lastEditorTabId = null;
let lastEditorPageType = null;

// === Открытие окна-консоли по клику на иконку ===
chrome.action.onClicked.addListener(async (tab) => {
  mainBrowserWindowId = tab.windowId;
  await openOrFocusConsoleWindow();
});

async function openOrFocusConsoleWindow() {
  // Проверяем, существует ли уже окно
  if (consoleWindowId !== null) {
    try {
      const win = await chrome.windows.get(consoleWindowId);
      if (win) {
        await chrome.windows.update(consoleWindowId, { focused: true });
        return;
      }
    } catch {
      consoleWindowId = null;
    }
  }

  // Восстанавливаем сохранённую позицию/размер
  const { windowBounds = DEFAULT_WINDOW } = await chrome.storage.local.get('windowBounds');

  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('src/ui/window.html'),
    type: 'popup',
    width: windowBounds.width,
    height: windowBounds.height,
    left: windowBounds.left,
    top: windowBounds.top
  });

  consoleWindowId = win.id;

  // Восстанавливаем pin state
  const { windowPinned = false } = await chrome.storage.local.get('windowPinned');
  pinned = windowPinned;

  addLog('System', 'Окно-консоль открыто', true);
}

// === Сохранение позиции/размера при перемещении ===
chrome.windows.onBoundsChanged?.addListener(async (window) => {
  if (window.id === consoleWindowId) {
    const bounds = { width: window.width, height: window.height, left: window.left, top: window.top };
    await chrome.storage.local.set({ windowBounds: bounds });
  }
});

// Fallback: save bounds periodically for Chrome versions without onBoundsChanged
setInterval(async () => {
  if (consoleWindowId === null) return;
  try {
    const win = await chrome.windows.get(consoleWindowId);
    if (win) {
      const bounds = { width: win.width, height: win.height, left: win.left, top: win.top };
      await chrome.storage.local.set({ windowBounds: bounds });
    }
  } catch {
    consoleWindowId = null;
  }
}, 10000);

// === Отслеживание закрытия окна-консоли ===
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === consoleWindowId) {
    consoleWindowId = null;
  }
});

// === Pin/Unpin: показывать/скрывать окно при потере фокуса ===
chrome.windows.onFocusChanged.addListener(async (focusedWindowId) => {
  if (consoleWindowId === null) return;
  if (focusedWindowId === consoleWindowId) return; // наше окно получило фокус — ничего не делаем

  if (focusedWindowId === chrome.windows.WINDOW_ID_NONE) {
    // Все окна потеряли фокус (например, другое приложение)
    // Если закреплено — не трогаем
    // Если не закреплено — скрываем (minimize)
    if (!pinned) {
      try {
        await chrome.windows.update(consoleWindowId, { state: 'minimized' });
      } catch {}
    }
    return;
  }

  // Фокус перешёл на другое окно Chrome
  if (!pinned) {
    // Не закреплено — при возврате в любое наше окно, показать консоль
    // (при переходе к чужому окну — скроется на следующей потере фокуса)
  }
});

// При активации вкладки — авто-контекст (если не привязано к конкретной вкладке)
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  // Recorder
  if (state.recording) {
    try {
      const tab = await chrome.tabs.get(activeInfo.tabId);
      if (tab.url && isAllowedUrl(tab.url)) {
        chrome.tabs.sendMessage(activeInfo.tabId, { type: 'START_RECORDING' }).catch(() => {});
      }
    } catch {}
  }

  // Авто-контекст (только если не привязано)
  if (boundTabId) return;
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url && tab.url.includes('otrs.tlpn') && tab.url.includes('AgentTicketZoom')) {
      // Автоматически парсим тикет
      chrome.tabs.sendMessage(activeInfo.tabId, { type: 'PARSE_OTRS' }, resp => {
        if (resp?.ok && resp.data) {
          state.ticketData = resp.data;
          broadcastToUI({ type: 'CONTEXT_CHANGED', data: resp.data });
        }
      });
    }
  } catch {}
});

// При обновлении привязанной вкладки — обновить контекст
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (boundTabId && tabId === boundTabId && tab.url) {
    if (tab.url.includes('otrs.tlpn')) {
      setTimeout(() => {
        chrome.tabs.sendMessage(tabId, { type: 'PARSE_OTRS' }, resp => {
          if (resp?.ok && resp.data) {
            state.ticketData = resp.data;
            broadcastToUI({ type: 'CONTEXT_CHANGED', data: resp.data });
          }
        });
      }, 1000);
    }
  }
});

// === Обработка сообщений ===
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    // === Данные от content scripts ===
    case 'OTRS_DATA_READY':
      state.ticketData = msg.data;
      broadcastToUI({ type: 'STATE_UPDATE', key: 'ticketData', data: msg.data });
      addLog('OTRS', 'Данные тикета получены', true);
      break;

    case 'ACCOUNTING_DATA_READY':
      state.accountingData = msg.data;
      broadcastToUI({ type: 'STATE_UPDATE', key: 'accountingData', data: msg.data });
      addLog('Accounting', 'Данные аккаунтинга получены', true);
      break;

    case 'RINGME_DATA_READY':
      state.ringmeData = msg.data;
      broadcastToUI({ type: 'STATE_UPDATE', key: 'ringmeData', data: msg.data });
      addLog('Ringme', 'Данные Ringme получены', true);
      break;

    case 'TELEO_DATA_READY':
      state.teleoData = msg.data;
      broadcastToUI({ type: 'STATE_UPDATE', key: 'teleoData', data: msg.data });
      addLog('Teleo', 'Данные Teleo получены', true);
      break;

    case 'OTRS_EDITOR_TAB_READY':
      lastEditorTabId = sender.tab?.id || null;
      lastEditorPageType = msg.pageType;
      addLog('OTRS', `Вкладка редактора (${msg.pageType}) зарегистрирована`, true);
      break;

    case 'LOGIN_REQUIRED':
      broadcastToUI({ type: 'LOGIN_REQUIRED', data: msg.data });
      addLog(msg.data.system, 'Требуется авторизация', false, 'Пользователь должен войти вручную');
      break;

    // === Recorder ===
    case 'RECORDER_STEP':
      if (state.recording) {
        state.recordedSteps.push(msg.step);
        broadcastToUI({ type: 'RECORDER_STEP_ADDED', step: msg.step, total: state.recordedSteps.length });
        addLog('Recorder', `Шаг записан: ${msg.step.action} на ${msg.step.selector}`, true);
      }
      break;

    // === Команды от UI ===
    case 'GET_STATE':
      sendResponse({ ok: true, state });
      return true;

    case 'SET_MODE':
      state.mode = msg.mode;
      addLog('System', `Режим изменён на: ${msg.mode}`, true);
      sendResponse({ ok: true });
      return true;

    case 'SET_PIN_STATE':
      pinned = msg.pinned;
      chrome.storage.local.set({ windowPinned: pinned });
      sendResponse({ ok: true });
      return true;

    case 'SET_DEBUG_MODE':
      state.debugMode = msg.enabled;
      sendResponse({ ok: true });
      return true;

    case 'BIND_TO_ACTIVE_TAB': {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, ([tab]) => {
        if (tab && tab.id !== sender.tab?.id) {
          boundTabId = tab.id;
          chrome.storage.local.set({ windowBoundTabId: boundTabId });
          sendResponse({ ok: true, tabId: boundTabId, url: tab.url });
        } else {
          // Попробуем найти OTRS вкладку
          chrome.tabs.query({}, allTabs => {
            const otrsTab = allTabs.find(t => t.url && t.url.includes('otrs.tlpn'));
            if (otrsTab) {
              boundTabId = otrsTab.id;
              chrome.storage.local.set({ windowBoundTabId: boundTabId });
              sendResponse({ ok: true, tabId: boundTabId, url: otrsTab.url });
            } else {
              sendResponse({ ok: false, error: 'OTRS вкладка не найдена' });
            }
          });
        }
      });
      return true;
    }

    case 'UNBIND_TAB':
      boundTabId = null;
      chrome.storage.local.set({ windowBoundTabId: null });
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

    case 'PARSE_TAB': {
      chrome.tabs.sendMessage(msg.tabId, { type: msg.parseType }, resp => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse(resp);
        }
      });
      return true;
    }

    case 'PARSE_ACTIVE_TAB': {
      const targetTabId = boundTabId;
      if (targetTabId) {
        chrome.tabs.sendMessage(targetTabId, { type: msg.parseType }, resp => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            sendResponse(resp);
          }
        });
      } else {
        chrome.tabs.query({ active: true, lastFocusedWindow: true }, ([tab]) => {
          if (!tab || tab.id === sender.tab?.id) {
            // Fallback: ищем OTRS вкладку
            chrome.tabs.query({}, allTabs => {
              const otrsTab = allTabs.find(t => t.url && t.url.includes('otrs.tlpn'));
              if (otrsTab) {
                chrome.tabs.sendMessage(otrsTab.id, { type: msg.parseType }, resp => {
                  if (chrome.runtime.lastError) {
                    sendResponse({ ok: false, error: chrome.runtime.lastError.message });
                  } else {
                    sendResponse(resp);
                  }
                });
              } else {
                sendResponse({ ok: false, error: 'OTRS вкладка не найдена' });
              }
            });
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
      }
      return true;
    }

    // === Template insertion ===
    case 'INSERT_TEMPLATE_OTRS': {
      // Приоритет: зарегистрированная вкладка compose/note > поиск среди всех вкладок
      const tryInsert = (tabId, cb) => {
        chrome.tabs.sendMessage(tabId, { type: 'INSERT_TEMPLATE', text: msg.text }, resp => {
          if (chrome.runtime.lastError) cb(null);
          else cb(resp);
        });
      };

      if (lastEditorTabId) {
        // Проверяем, жива ли зарегистрированная вкладка
        try {
          chrome.tabs.get(lastEditorTabId, (tab) => {
            if (chrome.runtime.lastError || !tab) {
              lastEditorTabId = null;
              fallbackInsert(msg.text, sendResponse);
            } else {
              tryInsert(lastEditorTabId, (resp) => {
                if (resp?.ok) sendResponse(resp);
                else fallbackInsert(msg.text, sendResponse);
              });
            }
          });
        } catch {
          lastEditorTabId = null;
          fallbackInsert(msg.text, sendResponse);
        }
      } else {
        fallbackInsert(msg.text, sendResponse);
      }
      return true;
    }

    // === Recording ===
    case 'START_RECORDING': {
      state.recording = true;
      state.recordedSteps = [];
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, ([tab]) => {
        if (tab && isAllowedUrl(tab.url || '')) {
          chrome.tabs.sendMessage(tab.id, { type: 'START_RECORDING' }).catch(() => {});
        }
      });
      addLog('Recorder', 'Запись начата', true);
      sendResponse({ ok: true });
      return true;
    }

    case 'STOP_RECORDING': {
      state.recording = false;
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, ([tab]) => {
        if (tab) {
          chrome.tabs.sendMessage(tab.id, { type: 'STOP_RECORDING' }).catch(() => {});
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

    // === Runexis ===
    case 'RUNEXIS_OPEN_TAB': {
      chrome.tabs.create({ url: msg.url, active: true }, tab => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true, tabId: tab.id });
        }
      });
      return true;
    }

    case 'RUNEXIS_ACTIVATE_TAB': {
      chrome.tabs.update(msg.tabId, { active: true }, tab => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true, tabId: tab?.id });
        }
      });
      return true;
    }

    case 'RUNEXIS_NAVIGATE_TAB': {
      chrome.tabs.update(msg.tabId, { url: msg.url }, tab => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true, tabId: tab?.id });
        }
      });
      return true;
    }

    case 'RUNEXIS_WAIT_TAB_LOAD': {
      const targetTabId = msg.tabId;
      const timeout = msg.timeout || 8000;
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(onUpdate);
        sendResponse({ ok: true, timedOut: true });
      }, timeout);
      function onUpdate(updatedId, changeInfo) {
        if (updatedId === targetTabId && changeInfo.status === 'complete') {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(onUpdate);
          setTimeout(() => sendResponse({ ok: true, timedOut: false }), 500);
        }
      }
      chrome.tabs.onUpdated.addListener(onUpdate);
      return true;
    }

    case 'RUNEXIS_SEND_TO_TAB': {
      chrome.tabs.sendMessage(msg.tabId, msg.message, resp => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse(resp);
        }
      });
      return true;
    }

    case 'RUNEXIS_FIND_TAB': {
      chrome.tabs.query({}, tabs => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        const found = tabs.find(t => t.url && t.url.includes('did-trunk.runexis.ru'));
        sendResponse({ ok: true, tabId: found?.id || null, url: found?.url || null });
      });
      return true;
    }

    case 'RUNEXIS_STORE_RESULT': {
      state.lastRunexisResult = msg.numbers;
      chrome.storage.local.set({ lastRunexisResult: msg.numbers });
      addLog('Runexis', `Сохранено ${msg.numbers.length} номеров`, true);
      sendResponse({ ok: true });
      return true;
    }

    case 'RUNEXIS_CLEAR_RESULT': {
      state.lastRunexisResult = null;
      chrome.storage.local.remove('lastRunexisResult');
      addLog('Runexis', 'Результат очищен', true);
      sendResponse({ ok: true });
      return true;
    }

    case 'RUNEXIS_GET_RESULT': {
      if (state.lastRunexisResult) {
        sendResponse({ ok: true, numbers: state.lastRunexisResult });
      } else {
        chrome.storage.local.get('lastRunexisResult', (data) => {
          sendResponse({ ok: true, numbers: data.lastRunexisResult || [] });
        });
      }
      return true;
    }

    case 'RUNEXIS_CHECK_OTRS_EDITOR': {
      chrome.tabs.query({}, tabs => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        const otrsEditor = tabs.find(t => t.url &&
          t.url.includes('otrs.tlpn') &&
          (t.url.includes('AgentTicketCompose') || t.url.includes('AgentTicketNote')));
        sendResponse({ ok: true, available: !!otrsEditor });
      });
      return true;
    }

    case 'RUNEXIS_INSERT_OTRS': {
      // Вставить lastRunexisResult в OTRS compose/note
      const text = msg.text;
      if (lastEditorTabId) {
        try {
          chrome.tabs.get(lastEditorTabId, (tab) => {
            if (chrome.runtime.lastError || !tab) {
              lastEditorTabId = null;
              fallbackInsert(text, sendResponse);
            } else {
              chrome.tabs.sendMessage(lastEditorTabId, { type: 'INSERT_TEMPLATE', text }, resp => {
                if (chrome.runtime.lastError) fallbackInsert(text, sendResponse);
                else sendResponse(resp || { ok: true });
              });
            }
          });
        } catch {
          lastEditorTabId = null;
          fallbackInsert(text, sendResponse);
        }
      } else {
        fallbackInsert(text, sendResponse);
      }
      return true;
    }

    // === Show/hide console ===
    case 'TOGGLE_CONSOLE':
      toggleConsoleVisibility();
      sendResponse({ ok: true });
      return true;

    default:
      break;
  }
});

function fallbackInsert(text, sendResponse) {
  // Поиск вкладки OTRS с формой: compose > note > email > zoom
  chrome.tabs.query({}, tabs => {
    const priorities = ['AgentTicketCompose', 'AgentTicketNote', 'AgentTicketEmail', 'AgentTicketZoom'];
    let bestTab = null;
    let bestPriority = priorities.length;
    for (const t of tabs) {
      if (!t.url || !t.url.includes('otrs.tlpn')) continue;
      for (let i = 0; i < priorities.length; i++) {
        if (t.url.includes(priorities[i]) && i < bestPriority) {
          bestTab = t;
          bestPriority = i;
          break;
        }
      }
    }
    if (bestTab) {
      chrome.tabs.sendMessage(bestTab.id, { type: 'INSERT_TEMPLATE', text }, resp => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse(resp || { ok: true });
        }
      });
    } else {
      sendResponse({ ok: false, error: 'OTRS вкладка с формой не найдена' });
    }
  });
}

async function toggleConsoleVisibility() {
  if (consoleWindowId === null) {
    await openOrFocusConsoleWindow();
    return;
  }
  try {
    const win = await chrome.windows.get(consoleWindowId);
    if (win.state === 'minimized') {
      await chrome.windows.update(consoleWindowId, { state: 'normal', focused: true });
    } else {
      await chrome.windows.update(consoleWindowId, { state: 'minimized' });
    }
  } catch {
    consoleWindowId = null;
    await openOrFocusConsoleWindow();
  }
}

function broadcastToUI(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {
    // UI window may not be open — ignore
  });
}

function isAllowedUrl(url) {
  const patterns = [
    'otrs.tlpn', 'intra10.office.tlpn', 'ringmeadmin.tlpn',
    'apiproxy.telphin.ru', 'teleo.telphin.ru', 'did-trunk.runexis.ru'
  ];
  return patterns.some(p => url.includes(p));
}
