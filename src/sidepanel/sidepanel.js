/**
 * Side Panel — основной UI расширения Auto Robotnik.
 */

import { addLog, getLogs, clearLogs, exportLogs } from '../storage/logger.js';
import { addTrainingExample, exportTrainingExamples, importTrainingExamples } from '../storage/training-store.js';
import { savePlaybook, getPlaybooks, deletePlaybook, exportPlaybooks, importPlaybooks } from '../storage/playbook-store.js';
import { addKnowledgeEntry, getKnowledgeEntries, deleteKnowledgeEntry, searchKnowledge, exportKnowledge, importKnowledge } from '../storage/knowledge-store.js';
import { BUILTIN_SCENARIOS } from '../playbook/scenarios.js';
import { PlaybookEngine, MODE_ASSIST, MODE_AUTOMATE } from '../playbook/engine.js';

// === State ===
let currentMode = MODE_ASSIST;
let ticketData = null;
let engine = new PlaybookEngine();
let isRecording = false;
let recordedSteps = [];

// === DOM refs ===
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// === Init ===
document.addEventListener('DOMContentLoaded', async () => {
  initTabs();
  initModeToggle();
  initTicketPanel();
  initPlaybookPanel();
  initRecorderPanel();
  initKnowledgePanel();
  initLogsPanel();
  initCopyButtons();
  requestInitialData();
  listenForUpdates();
});

// === Tabs ===
function initTabs() {
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach(t => t.classList.remove('active'));
      $$('.panel').forEach(p => p.classList.add('hidden'));
      tab.classList.add('active');
      $(`#panel-${tab.dataset.tab}`).classList.remove('hidden');
    });
  });
}

// === Mode Toggle ===
function initModeToggle() {
  const toggle = $('#modeToggle');
  const label = $('#modeLabel');
  toggle.addEventListener('change', () => {
    currentMode = toggle.checked ? MODE_AUTOMATE : MODE_ASSIST;
    label.textContent = toggle.checked ? 'Automate' : 'Assist';
    engine.setMode(currentMode);
    chrome.runtime.sendMessage({ type: 'SET_MODE', mode: currentMode });
    addLog('UI', `Режим: ${currentMode}`, true);
  });
}

// === Ticket Panel ===
function initTicketPanel() {
  $('#btn-refreshData').addEventListener('click', requestInitialData);
  $('#btn-confirmCorrect').addEventListener('click', async () => {
    if (ticketData) {
      await addTrainingExample({
        ticketText: ticketData.bodyExcerpt || '',
        metadata: { ticketId: ticketData.ticketId, clientCode: ticketData.clientCode },
        result: 'OK'
      });
      showToast('Данные подтверждены и сохранены');
    }
  });
  $('#btn-confirmWrong').addEventListener('click', () => {
    $('#correction-panel').style.display = 'block';
    if (ticketData) {
      $('#fix-clientCode').value = ticketData.clientCode || '';
      $('#fix-lineNumber').value = (ticketData.lineNumbers || [])[0] || '';
      $('#fix-atcPlan').value = ticketData.atcPlan || '';
    }
  });
  $('#btn-applyFix').addEventListener('click', async () => {
    const fixes = {
      clientCode: $('#fix-clientCode').value.trim(),
      lineNumber: $('#fix-lineNumber').value.trim(),
      atcPlan: $('#fix-atcPlan').value
    };
    if (ticketData) {
      ticketData.clientCode = fixes.clientCode || ticketData.clientCode;
      if (fixes.lineNumber) ticketData.lineNumbers = [fixes.lineNumber];
      ticketData.atcPlan = fixes.atcPlan || ticketData.atcPlan;
      updateTicketCard(ticketData);
      await addTrainingExample({
        ticketText: ticketData.bodyExcerpt || '',
        metadata: { ticketId: ticketData.ticketId },
        chosenCase: 'correction',
        params: fixes,
        result: 'OK',
        corrections: JSON.stringify(fixes)
      });
      showToast('Данные исправлены');
    }
    $('#correction-panel').style.display = 'none';
  });
}

function updateTicketCard(data) {
  ticketData = data;
  $('#val-ticketId').textContent = data.ticketId || '—';
  $('#val-clientCode').textContent = data.clientCode || '—';
  $('#val-lineNumber').textContent = (data.lineNumbers || [])[0] || data.lineNumber || '—';
  $('#val-atcPlan').textContent = data.atcPlan || '—';

  const servicesEl = $('#val-services');
  servicesEl.innerHTML = '';
  const services = data.services || [];
  if (services.length > 0) {
    services.forEach(s => {
      const div = document.createElement('div');
      div.textContent = s.raw || s.cells?.join(' | ') || JSON.stringify(s);
      div.style.fontSize = '11px';
      servicesEl.appendChild(div);
    });
  } else {
    servicesEl.textContent = '—';
  }

  updateQuickLinks(data);
}

function updateQuickLinks(data) {
  const container = $('#quickLinks');
  container.innerHTML = '';
  const cc = data.clientCode || '';
  const ln = (data.lineNumbers || [])[0] || data.lineNumber || '';
  const tid = data.ticketId || '';

  const links = [
    { system: 'OTRS', label: 'Тикет', url: tid ? `http://otrs.tlpn/otrs/index.pl?Action=AgentTicketZoom;TicketID=${tid}` : '' },
    { system: 'Accounting', label: 'Аккаунтинг', url: cc ? `http://intra10.office.tlpn/admin/customer_show.php?otrs_customer=${cc}` : '' },
    { system: 'Support', label: 'Support Script (АТС)', url: 'http://intra10.office.tlpn/support/support_script/index.php?id=atc_teleo' },
    { system: 'Ringme', label: 'Ringme поиск', url: cc ? `https://ringmeadmin.tlpn/clients/?q=${cc}` : '' },
    { system: 'Teleo', label: 'Teleo', url: 'https://teleo.telphin.ru/' },
    { system: 'Teleo', label: 'Сотрудники', url: 'https://teleo.telphin.ru/staff/' },
    { system: 'Teleo', label: 'Маршрутизация', url: 'https://teleo.telphin.ru/routing_new/' }
  ];

  for (const link of links) {
    if (!link.url) continue;
    const el = document.createElement('a');
    el.className = 'quick-link';
    el.href = link.url;
    el.target = '_blank';
    el.rel = 'noopener';
    el.innerHTML = `<span class="quick-link__system">${link.system}</span> ${link.label}`;
    el.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: 'OPEN_TAB', url: link.url, activate: true });
    });
    container.appendChild(el);
  }

  // Копирование значений
  if (cc) addCopyLink(container, 'Код клиента', cc);
  if (ln) addCopyLink(container, 'Номер линии', ln);
}

function addCopyLink(container, label, value) {
  const el = document.createElement('div');
  el.className = 'quick-link';
  el.innerHTML = `<span class="quick-link__system">Копировать</span> ${label}: <span class="step-item__copy-val">${value}</span>`;
  el.addEventListener('click', () => {
    navigator.clipboard.writeText(value);
    showToast(`Скопировано: ${value}`);
  });
  container.appendChild(el);
}

// === Playbook Panel ===
function initPlaybookPanel() {
  renderScenarioList();
  $('#btn-nextStep').addEventListener('click', runNextStep);
  $('#btn-stopPlaybook').addEventListener('click', stopPlaybook);
}

async function renderScenarioList() {
  const container = $('#scenarioList');
  container.innerHTML = '';

  // Built-in
  for (const sc of BUILTIN_SCENARIOS) {
    const el = createScenarioItem(sc, true);
    container.appendChild(el);
  }

  // User playbooks
  const userPlaybooks = await getPlaybooks();
  for (const pb of userPlaybooks) {
    const el = createScenarioItem(pb, false);
    container.appendChild(el);
  }
}

function createScenarioItem(scenario, builtIn) {
  const el = document.createElement('div');
  el.className = 'scenario-item';
  el.innerHTML = `
    <span class="scenario-item__name">${scenario.name}</span>
    <span class="scenario-item__badge">${builtIn ? 'встроенный' : 'пользовательский'} · ${scenario.steps.length} шагов</span>
  `;
  el.addEventListener('click', () => startPlaybook(scenario));
  return el;
}

async function startPlaybook(scenario) {
  engine = new PlaybookEngine();
  engine.setMode(currentMode);

  // Merge ticket data into context
  if (ticketData) {
    engine.context = {
      ticketId: ticketData.ticketId || '',
      clientCode: ticketData.clientCode || '',
      lineNumber: (ticketData.lineNumbers || [])[0] || ticketData.lineNumber || '',
      atcPlan: ticketData.atcPlan || ''
    };
  }

  engine.onStepUpdate = (idx, status, data) => updateStepUI(idx, status, data);
  engine.onConfirmNeeded = (idx, step) => confirmStep(idx, step);
  engine.onLog = (system, action, ok, error) => addLog(system, action, ok, error);
  engine.onModeFallback = (idx, reason) => {
    showToast(`Automate → Assist: ${reason}. Обучите шаг через Запись.`);
    $('#modeToggle').checked = false;
    $('#modeLabel').textContent = 'Assist';
    currentMode = MODE_ASSIST;
  };

  await engine.loadPlaybook(scenario);
  $('#playbookRunner').classList.remove('hidden');
  $('#playbookRunnerTitle').textContent = scenario.name;
  renderPlaybookSteps(scenario.steps);
  addLog('Playbook', `Запущен: ${scenario.name}`, true);
}

function renderPlaybookSteps(steps) {
  const container = $('#playbookSteps');
  container.innerHTML = '';
  steps.forEach((step, i) => {
    const el = document.createElement('div');
    el.className = 'step-item step-item--pending';
    el.id = `step-${i}`;
    el.innerHTML = `
      <span class="step-item__num">${i + 1}</span>
      <span class="step-item__desc">
        <span class="step-item__system">[${step.system}]</span> ${step.description}
      </span>
      <span class="step-item__status">ожидает</span>
    `;
    container.appendChild(el);
  });
}

function updateStepUI(idx, status, data) {
  const el = $(`#step-${idx}`);
  if (!el) return;

  el.className = `step-item step-item--${status}`;
  const statusEl = el.querySelector('.step-item__status');
  const statusMap = {
    running: 'выполняется',
    done: 'готово',
    error: 'ошибка',
    assist: 'assist',
    skipped: 'пропущен',
    pending: 'ожидает'
  };
  statusEl.textContent = statusMap[status] || status;

  // Assist data — показать ссылки/значения
  if (status === 'assist' && data) {
    const extra = document.createElement('div');
    extra.style.marginTop = '4px';
    if (data.link) {
      const a = document.createElement('a');
      a.className = 'step-item__link';
      a.textContent = data.label || 'Открыть';
      a.href = data.link;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.runtime.sendMessage({ type: 'OPEN_TAB', url: data.link, activate: true });
      });
      extra.appendChild(a);
    }
    if (data.copyValue) {
      const span = document.createElement('span');
      span.className = 'step-item__copy-val';
      span.textContent = data.copyValue;
      span.title = 'Нажмите для копирования';
      span.addEventListener('click', () => {
        navigator.clipboard.writeText(data.copyValue);
        showToast(`Скопировано: ${data.copyValue}`);
      });
      extra.appendChild(document.createTextNode(' '));
      extra.appendChild(span);
    }
    el.querySelector('.step-item__desc').appendChild(extra);
  }

  if (status === 'error' && data) {
    const errDiv = document.createElement('div');
    errDiv.style.cssText = 'color: var(--error); font-size: 10px; margin-top: 2px;';
    errDiv.textContent = data;
    el.querySelector('.step-item__desc').appendChild(errDiv);
  }
}

async function runNextStep() {
  const result = await engine.runNext();
  if (result?.done) {
    showToast('Сценарий завершён');
    addLog('Playbook', 'Сценарий завершён', true);
  }
}

function stopPlaybook() {
  engine = new PlaybookEngine();
  $('#playbookRunner').classList.add('hidden');
  addLog('Playbook', 'Сценарий остановлен', true);
}

function confirmStep(idx, step) {
  return new Promise((resolve) => {
    const container = $(`#step-${idx}`);
    if (!container) { resolve(true); return; }

    const bar = document.createElement('div');
    bar.className = 'confirm-bar';
    bar.innerHTML = `
      <span class="confirm-bar__text">Выполнить шаг: ${step.description}?</span>
      <button class="btn btn--primary btn-confirm-yes">Да</button>
      <button class="btn btn--warn btn-confirm-no">Пропустить</button>
    `;
    container.appendChild(bar);

    bar.querySelector('.btn-confirm-yes').addEventListener('click', () => {
      bar.remove();
      resolve(true);
    });
    bar.querySelector('.btn-confirm-no').addEventListener('click', () => {
      bar.remove();
      resolve(false);
    });
  });
}

// === Recorder Panel ===
function initRecorderPanel() {
  $('#btn-startRecord').addEventListener('click', async () => {
    isRecording = true;
    recordedSteps = [];
    $('#btn-startRecord').disabled = true;
    $('#btn-stopRecord').disabled = false;
    $('#recordedStepsList').innerHTML = '';
    $('#recordActions').style.display = 'none';
    chrome.runtime.sendMessage({ type: 'START_RECORDING' });
    addLog('Recorder', 'Запись начата', true);
    showToast('Запись начата. Выполняйте действия на странице.');
  });

  $('#btn-stopRecord').addEventListener('click', async () => {
    isRecording = false;
    $('#btn-startRecord').disabled = false;
    $('#btn-stopRecord').disabled = true;
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }, resp => {
      if (resp?.steps) {
        recordedSteps = resp.steps;
        renderRecordedSteps();
      }
    });
    addLog('Recorder', 'Запись остановлена', true);
    showToast('Запись завершена.');
  });

  $('#btn-saveRecording').addEventListener('click', async () => {
    const name = $('#recordName').value.trim() || 'Записанный сценарий';
    const playbook = {
      name,
      steps: recordedSteps.map(s => ({
        id: crypto.randomUUID(),
        description: `${s.action}: ${s.text || s.selector}`,
        system: 'User',
        action: s.action === 'input' ? 'fill' : 'click',
        params: {
          selector: s.selector,
          value: s.value || ''
        },
        waitForConfirm: true
      }))
    };
    await savePlaybook(playbook);
    showToast(`Playbook "${name}" сохранён`);
    addLog('Recorder', `Playbook сохранён: ${name}`, true);
    renderScenarioList();
    recordedSteps = [];
    $('#recordedStepsList').innerHTML = '';
    $('#recordActions').style.display = 'none';
  });

  // Import/Export
  $('#btn-exportPlaybooks').addEventListener('click', async () => {
    const json = await exportPlaybooks();
    downloadJSON(json, 'playbooks.json');
  });
  $('#btn-importPlaybooks').addEventListener('click', () => $('#file-importPlaybooks').click());
  $('#file-importPlaybooks').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    try {
      const count = await importPlaybooks(text);
      showToast(`Импортировано playbooks: ${count}`);
      renderScenarioList();
    } catch (err) {
      showToast(`Ошибка: ${err.message}`);
    }
    e.target.value = '';
  });

  $('#btn-exportTraining').addEventListener('click', async () => {
    const json = await exportTrainingExamples();
    downloadJSON(json, 'training-examples.json');
  });
  $('#btn-importTraining').addEventListener('click', () => $('#file-importTraining').click());
  $('#file-importTraining').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    try {
      const count = await importTrainingExamples(text);
      showToast(`Импортировано примеров: ${count}`);
    } catch (err) {
      showToast(`Ошибка: ${err.message}`);
    }
    e.target.value = '';
  });
}

function renderRecordedSteps() {
  const container = $('#recordedStepsList');
  container.innerHTML = '';
  recordedSteps.forEach((step, i) => {
    const el = document.createElement('div');
    el.className = 'step-item step-item--done';
    el.innerHTML = `
      <span class="step-item__num">${i + 1}</span>
      <span class="step-item__desc">
        <strong>${step.action}</strong>: ${step.text || step.selector}
        ${step.value ? `<br><span class="step-item__copy-val">${step.value}</span>` : ''}
      </span>
    `;
    container.appendChild(el);
  });
  if (recordedSteps.length > 0) {
    $('#recordActions').style.display = 'block';
  }
}

// === Knowledge Panel ===
function initKnowledgePanel() {
  let debounceTimer;
  $('#kb-search').addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(renderKnowledgeList, 300);
  });

  $('#btn-addKb').addEventListener('click', async () => {
    const title = $('#kb-title').value.trim();
    const text = $('#kb-text').value.trim();
    const tags = $('#kb-tags').value.split(',').map(t => t.trim()).filter(Boolean);
    if (!text) { showToast('Введите текст заметки'); return; }
    await addKnowledgeEntry({ title, text, tags });
    $('#kb-title').value = '';
    $('#kb-text').value = '';
    $('#kb-tags').value = '';
    showToast('Заметка добавлена');
    renderKnowledgeList();
  });

  // Import/Export
  $('#btn-exportKb').addEventListener('click', async () => {
    const json = await exportKnowledge();
    downloadJSON(json, 'knowledge-base.json');
  });
  $('#btn-importKb').addEventListener('click', () => $('#file-importKb').click());
  $('#file-importKb').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    try {
      const count = await importKnowledge(text);
      showToast(`Импортировано записей: ${count}`);
      renderKnowledgeList();
    } catch (err) {
      showToast(`Ошибка: ${err.message}`);
    }
    e.target.value = '';
  });

  renderKnowledgeList();
}

async function renderKnowledgeList() {
  const container = $('#kb-list');
  container.innerHTML = '';
  const allEntries = await getKnowledgeEntries();
  const query = $('#kb-search').value.trim();
  const entries = query ? searchKnowledge(allEntries, query) : allEntries;

  if (entries.length === 0) {
    container.innerHTML = '<div style="color: var(--text-muted); font-size: 12px;">Нет записей</div>';
    return;
  }

  for (const entry of entries.slice().reverse()) {
    const el = document.createElement('div');
    el.className = 'kb-entry';
    el.innerHTML = `
      <div class="kb-entry__title">${escapeHtml(entry.title || 'Без заголовка')}</div>
      <div class="kb-entry__text">${escapeHtml(entry.text)}</div>
      <div class="kb-entry__tags">
        ${entry.tags.map(t => `<span class="kb-tag">${escapeHtml(t)}</span>`).join('')}
      </div>
      <div class="kb-entry__actions">
        <button class="btn btn--warn" data-delete-kb="${entry.id}" style="font-size:10px;">Удалить</button>
      </div>
    `;
    el.querySelector(`[data-delete-kb="${entry.id}"]`).addEventListener('click', async () => {
      await deleteKnowledgeEntry(entry.id);
      renderKnowledgeList();
    });
    container.appendChild(el);
  }
}

// === Logs Panel ===
function initLogsPanel() {
  $('#btn-refreshLogs').addEventListener('click', renderLogs);
  $('#btn-exportLogs').addEventListener('click', async () => {
    const json = await exportLogs();
    downloadJSON(json, 'logs.json');
  });
  $('#btn-clearLogs').addEventListener('click', async () => {
    await clearLogs();
    renderLogs();
    showToast('Логи очищены');
  });
  renderLogs();
}

async function renderLogs() {
  const container = $('#logsList');
  container.innerHTML = '';
  const logs = await getLogs(500);

  for (const log of logs.slice().reverse()) {
    const el = document.createElement('div');
    el.className = `log-entry ${log.ok ? 'log-entry--ok' : 'log-entry--err'}`;
    const time = new Date(log.ts).toLocaleTimeString('ru-RU');
    el.innerHTML = `
      <span class="log-entry__ts">${time}</span>
      <span class="log-entry__sys">${escapeHtml(log.system)}</span>
      <span class="log-entry__action">${escapeHtml(log.action)}${log.error ? ' — ' + escapeHtml(log.error) : ''}</span>
    `;
    container.appendChild(el);
  }
}

// === Copy buttons ===
function initCopyButtons() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-copy');
    if (!btn) return;
    const targetId = btn.dataset.copy;
    const el = document.getElementById(targetId);
    if (!el) return;
    const text = el.textContent.trim();
    if (text && text !== '—') {
      navigator.clipboard.writeText(text);
      showToast(`Скопировано: ${text}`);
    }
  });
}

// === Data flow ===
function requestInitialData() {
  // Try to get data from background state
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, resp => {
    if (resp?.state?.ticketData) {
      updateTicketCard(resp.state.ticketData);
    }
    if (resp?.state?.accountingData) {
      mergeAccountingData(resp.state.accountingData);
    }
  });

  // Also try parsing the active tab
  chrome.runtime.sendMessage({ type: 'PARSE_ACTIVE_TAB', parseType: 'PARSE_OTRS' }, resp => {
    if (resp?.ok && resp.data) {
      updateTicketCard(resp.data);
    }
  });
}

function mergeAccountingData(data) {
  if (!ticketData) ticketData = {};
  if (data.lineNumber) ticketData.lineNumber = data.lineNumber;
  if (!ticketData.lineNumbers) ticketData.lineNumbers = [];
  if (data.lineNumber && !ticketData.lineNumbers.includes(data.lineNumber)) {
    ticketData.lineNumbers.unshift(data.lineNumber);
  }
  if (data.services) ticketData.services = data.services;
  updateTicketCard(ticketData);
}

function listenForUpdates() {
  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'STATE_UPDATE':
        if (msg.key === 'ticketData' && msg.data) {
          updateTicketCard(msg.data);
        }
        if (msg.key === 'accountingData' && msg.data) {
          mergeAccountingData(msg.data);
        }
        break;
      case 'LOGIN_REQUIRED':
        showToast(`${msg.data.system}: требуется авторизация. Войдите вручную и нажмите "Обновить данные".`);
        break;
      case 'RECORDER_STEP_ADDED':
        if (isRecording) {
          recordedSteps.push(msg.step);
          renderRecordedSteps();
        }
        break;
    }
  });
}

// === Utilities ===
function showToast(text) {
  const toast = $('#toast');
  toast.textContent = text;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 3000);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function downloadJSON(jsonStr, filename) {
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
