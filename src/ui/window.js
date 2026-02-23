/**
 * Window UI — основной UI расширения Auto Robotnik.
 * Отдельное окно (popup window), а не side panel.
 * Включает: контекст тикета, pin/unpin, bind-to-tab, шаблоны, всё остальное.
 */

import { addLog, getLogs, clearLogs, exportLogs } from '../storage/logger.js';
import { addTrainingExample, exportTrainingExamples, importTrainingExamples } from '../storage/training-store.js';
import { savePlaybook, getPlaybooks, deletePlaybook, exportPlaybooks, importPlaybooks } from '../storage/playbook-store.js';
import { addKnowledgeEntry, getKnowledgeEntries, deleteKnowledgeEntry, searchKnowledge, exportKnowledge, importKnowledge } from '../storage/knowledge-store.js';
import {
  addTemplate, getTemplates, deleteTemplate, updateTemplate, searchTemplates,
  resolveTemplatePlaceholders, recordTemplateUsage, getRecommendedTemplates,
  exportTemplates, importTemplates
} from '../storage/template-store.js';
import { BUILTIN_SCENARIOS, SCENARIO_RUNEXIS_NUMBERS } from '../playbook/scenarios.js';
import { PlaybookEngine, MODE_ASSIST, MODE_AUTOMATE } from '../playbook/engine.js';

// === State ===
let currentMode = MODE_ASSIST;
let ticketData = null;
let engine = new PlaybookEngine();
let isRecording = false;
let recordedSteps = [];
let isPinned = false;
let boundTabId = null; // null = авто-режим, число = привязка к вкладке
let debugMode = false;
let editingTemplateId = null; // для редактирования шаблона

// === DOM refs ===
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// === Init ===
document.addEventListener('DOMContentLoaded', async () => {
  initTabs();
  initModeToggle();
  initPinButton();
  initContextBar();
  initTicketPanel();
  initPlaybookPanel();
  initTemplatePanel();
  initRecorderPanel();
  initKnowledgePanel();
  initLogsPanel();
  initCopyButtons();
  initDebugModeHotkey();
  await restoreState();
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

// === Pin/Unpin ===
function initPinButton() {
  const btn = $('#btn-pin');
  btn.addEventListener('click', () => {
    isPinned = !isPinned;
    btn.classList.toggle('pinned', isPinned);
    btn.title = isPinned ? 'Окно закреплено (клик — открепить)' : 'Закрепить окно';
    chrome.runtime.sendMessage({ type: 'SET_PIN_STATE', pinned: isPinned });
    addLog('UI', isPinned ? 'Окно закреплено' : 'Окно откреплено', true);
  });
}

// === Context Bar ===
function initContextBar() {
  $('#btn-bindTab').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'BIND_TO_ACTIVE_TAB' }, resp => {
      if (resp?.ok) {
        boundTabId = resp.tabId;
        updateContextBarState('bound', `Привязано к вкладке #${resp.tabId}`);
        $('#btn-bindTab').style.display = 'none';
        $('#btn-unbindTab').style.display = '';
        addLog('UI', `Привязка к вкладке #${resp.tabId}`, true);
      }
    });
  });

  $('#btn-unbindTab').addEventListener('click', () => {
    boundTabId = null;
    chrome.runtime.sendMessage({ type: 'UNBIND_TAB' });
    updateContextBarState('active', 'авто-режим');
    $('#btn-bindTab').style.display = '';
    $('#btn-unbindTab').style.display = 'none';
    addLog('UI', 'Привязка снята', true);
  });

  $('#btn-refreshCtx').addEventListener('click', requestInitialData);

  $('#btn-openTicket').addEventListener('click', () => {
    if (ticketData?.ticketId) {
      const url = `http://otrs.tlpn/otrs/index.pl?Action=AgentTicketZoom;TicketID=${ticketData.ticketId}`;
      chrome.runtime.sendMessage({ type: 'OPEN_TAB', url, activate: true });
    }
  });
}

function updateContextBarState(state, text) {
  const el = $('#ctxStatus');
  el.className = `context-bar__status ${state}`;
  el.textContent = text;
}

function updateContextBarData(data) {
  const ticketDisplay = data?.ticketNumber || (data?.ticketId ? `#${data.ticketId}` : '');
  $('#ctxTicketNumber').textContent = ticketDisplay;
  $('#ctxClientCode').textContent = data?.clientCode || '';
  if (data?.ticketId || data?.ticketNumber) {
    updateContextBarState(boundTabId ? 'bound' : 'active', boundTabId ? 'привязано' : 'контекст найден');
  }
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
  $('#val-ticketNumber').textContent = data.ticketNumber || '—';
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
  updateContextBarData(data);
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
    el.innerHTML = `<span class="quick-link__system">${link.system}</span> ${link.label}`;
    el.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: 'OPEN_TAB', url: link.url, activate: true });
    });
    container.appendChild(el);
  }

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
  for (const sc of BUILTIN_SCENARIOS) {
    container.appendChild(createScenarioItem(sc, true));
  }
  const userPlaybooks = await getPlaybooks();
  for (const pb of userPlaybooks) {
    container.appendChild(createScenarioItem(pb, false));
  }
}

function createScenarioItem(scenario, builtIn) {
  const el = document.createElement('div');
  el.className = 'scenario-item';
  el.innerHTML = `
    <div class="scenario-item__info">
      <span class="scenario-item__name">${escapeHtml(scenario.name)}</span>
      <span class="scenario-item__badge">${builtIn ? 'встроенный' : 'пользовательский'} · ${scenario.steps.length} шагов</span>
    </div>
    ${builtIn ? '' : `<div class="scenario-item__actions">
      <button class="btn-icon sc-edit" title="Редактировать">&#9998;</button>
      <button class="btn-icon sc-duplicate" title="Дублировать">&#128203;</button>
      <button class="btn-icon sc-delete" title="Удалить">&#128465;</button>
    </div>`}
  `;

  // Click on info area to start playbook
  el.querySelector('.scenario-item__info').addEventListener('click', () => startPlaybook(scenario));

  if (!builtIn) {
    el.querySelector('.sc-edit').addEventListener('click', (e) => {
      e.stopPropagation();
      editScenario(scenario);
    });
    el.querySelector('.sc-duplicate').addEventListener('click', async (e) => {
      e.stopPropagation();
      const copy = { ...scenario, id: undefined, name: scenario.name + ' (копия)' };
      await savePlaybook(copy);
      showToast('Сценарий дублирован');
      renderScenarioList();
    });
    el.querySelector('.sc-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      showDeleteConfirm(el, scenario);
    });
  }

  return el;
}

function showDeleteConfirm(container, scenario) {
  // Remove existing confirm bars
  const existing = container.querySelector('.confirm-bar');
  if (existing) { existing.remove(); return; }

  const bar = document.createElement('div');
  bar.className = 'confirm-bar';
  bar.innerHTML = `
    <span class="confirm-bar__text">Удалить "${escapeHtml(scenario.name)}"?</span>
    <button class="btn btn--primary">Да</button>
    <button class="btn">Нет</button>
  `;
  bar.querySelector('.btn--primary').addEventListener('click', async () => {
    await deletePlaybook(scenario.id);
    showToast('Сценарий удалён');
    renderScenarioList();
  });
  bar.querySelector('.btn:last-child').addEventListener('click', () => bar.remove());
  container.appendChild(bar);
}

function editScenario(scenario) {
  // Simple rename via prompt-like inline edit
  const newName = prompt('Название сценария:', scenario.name);
  if (newName && newName.trim() && newName.trim() !== scenario.name) {
    scenario.name = newName.trim();
    savePlaybook(scenario).then(() => {
      showToast('Сценарий переименован');
      renderScenarioList();
    });
  }
}

async function startPlaybook(scenario) {
  // Runexis — специальный wizard вместо стандартного engine
  if (scenario.id === 'builtin_runexis_numbers') {
    showRunexisWizard();
    return;
  }

  engine = new PlaybookEngine();
  engine.setMode(currentMode);
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
    showToast(`Automate -> Assist: ${reason}. Обучите шаг через Запись.`);
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
    running: 'выполняется', done: 'готово', error: 'ошибка',
    assist: 'assist', skipped: 'пропущен', pending: 'ожидает'
  };
  statusEl.textContent = statusMap[status] || status;

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
    bar.querySelector('.btn-confirm-yes').addEventListener('click', () => { bar.remove(); resolve(true); });
    bar.querySelector('.btn-confirm-no').addEventListener('click', () => { bar.remove(); resolve(false); });
  });
}

// === Template Panel ===
function initTemplatePanel() {
  let debounceTimer;
  $('#tpl-search').addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(renderTemplateList, 300);
  });

  $('#btn-addTpl').addEventListener('click', async () => {
    const name = $('#tpl-name').value.trim();
    const category = $('#tpl-category').value.trim();
    const tags = $('#tpl-tags').value.split(',').map(t => t.trim()).filter(Boolean);
    const body = $('#tpl-body').value.trim();
    if (!body) { showToast('Введите текст шаблона'); return; }
    await addTemplate({ name, category, tags, body });
    $('#tpl-name').value = '';
    $('#tpl-category').value = '';
    $('#tpl-tags').value = '';
    $('#tpl-body').value = '';
    showToast('Шаблон добавлен');
    renderTemplateList();
  });

  $('#btn-exportTpl').addEventListener('click', async () => {
    const json = await exportTemplates();
    downloadJSON(json, 'templates.json');
  });
  $('#btn-importTpl').addEventListener('click', () => $('#file-importTpl').click());
  $('#file-importTpl').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    try {
      const count = await importTemplates(text);
      showToast(`Импортировано шаблонов: ${count}`);
      renderTemplateList();
    } catch (err) {
      showToast(`Ошибка: ${err.message}`);
    }
    e.target.value = '';
  });

  initTemplateEditorButtons();
  renderTemplateList();
}

async function renderTemplateList() {
  const container = $('#tpl-list');
  container.innerHTML = '';
  const allTemplates = await getTemplates();
  const query = $('#tpl-search').value.trim();
  const templates = query ? searchTemplates(allTemplates, query) : allTemplates;

  // Рекомендации
  const recContainer = $('#tpl-recommended-list');
  recContainer.innerHTML = '';
  if (ticketData && allTemplates.length > 0) {
    const recommended = await getRecommendedTemplates(
      { ticketId: ticketData.ticketId, clientCode: ticketData.clientCode, queue: '', keywords: [] },
      allTemplates, 3
    );
    if (recommended.length > 0) {
      $('#tpl-recommended').style.display = 'block';
      for (const tpl of recommended) {
        recContainer.appendChild(createTemplateItem(tpl, true));
      }
    } else {
      $('#tpl-recommended').style.display = 'none';
    }
  } else {
    $('#tpl-recommended').style.display = 'none';
  }

  if (templates.length === 0) {
    container.innerHTML = '<div style="color: var(--text-muted); font-size: 12px;">Нет шаблонов</div>';
    return;
  }

  for (const tpl of templates.slice().reverse()) {
    container.appendChild(createTemplateItem(tpl, false));
  }
}

function createTemplateItem(tpl, isRecommended) {
  const el = document.createElement('div');
  el.className = 'tpl-item';
  const preview = tpl.body.substring(0, 100).replace(/\n/g, ' ');
  el.innerHTML = `
    <div>
      <span class="tpl-item__name">${escapeHtml(tpl.name)}</span>
      ${tpl.category ? `<span class="tpl-item__category">[${escapeHtml(tpl.category)}]</span>` : ''}
    </div>
    <div class="tpl-item__preview">${escapeHtml(preview)}...</div>
    <div class="tpl-item__tags">
      ${(tpl.tags || []).map(t => `<span class="tpl-tag">${escapeHtml(t)}</span>`).join('')}
    </div>
    <div class="tpl-item__actions">
      <button class="btn btn--primary btn-insert-tpl" style="font-size:10px;">Вставить в OTRS</button>
      <button class="btn btn-copy-tpl" style="font-size:10px;">Копировать</button>
      ${isRecommended ? '' : `<button class="btn btn-edit-tpl" style="font-size:10px;">Редактировать</button>`}
      ${isRecommended ? '' : `<button class="btn btn--warn btn-delete-tpl" style="font-size:10px;">Удалить</button>`}
    </div>
  `;

  el.querySelector('.btn-insert-tpl').addEventListener('click', (e) => {
    e.stopPropagation();
    insertTemplateIntoOTRS(tpl);
  });
  el.querySelector('.btn-copy-tpl').addEventListener('click', (e) => {
    e.stopPropagation();
    const resolved = resolveTemplatePlaceholders(tpl.body, ticketData || {});
    navigator.clipboard.writeText(resolved);
    showToast('Шаблон скопирован в буфер');
  });
  const editBtn = el.querySelector('.btn-edit-tpl');
  if (editBtn) {
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openTemplateEditor(tpl);
    });
  }
  const delBtn = el.querySelector('.btn-delete-tpl');
  if (delBtn) {
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteTemplate(tpl.id);
      renderTemplateList();
    });
  }

  return el;
}

async function insertTemplateIntoOTRS(tpl) {
  const resolved = resolveTemplatePlaceholders(tpl.body, ticketData || {});

  // Отправляем в content script OTRS для вставки
  chrome.runtime.sendMessage(
    { type: 'INSERT_TEMPLATE_OTRS', text: resolved },
    resp => {
      if (resp?.ok) {
        showToast('Шаблон вставлен в OTRS');
        // Записать usage для обучения
        if (ticketData) {
          recordTemplateUsage(
            { ticketId: ticketData.ticketId, clientCode: ticketData.clientCode },
            tpl.id
          );
        }
        addLog('Templates', `Шаблон вставлен: ${tpl.name}`, true);
      } else {
        showToast(`Ошибка вставки: ${resp?.error || 'OTRS не открыт'}`);
        // Fallback — копируем
        navigator.clipboard.writeText(resolved);
        showToast('Скопировано в буфер (OTRS-вкладка не найдена)');
      }
    }
  );
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
        params: { selector: s.selector, value: s.value || '' },
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

  $('#btn-exportPlaybooks').addEventListener('click', async () => {
    const json = await exportPlaybooks();
    downloadJSON(json, 'playbooks.json');
  });
  $('#btn-importPlaybooks').addEventListener('click', () => $('#file-importPlaybooks').click());
  $('#file-importPlaybooks').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const count = await importPlaybooks(await file.text());
      showToast(`Импортировано playbooks: ${count}`);
      renderScenarioList();
    } catch (err) { showToast(`Ошибка: ${err.message}`); }
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
    try {
      const count = await importTrainingExamples(await file.text());
      showToast(`Импортировано примеров: ${count}`);
    } catch (err) { showToast(`Ошибка: ${err.message}`); }
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

  $('#btn-exportKb').addEventListener('click', async () => {
    const json = await exportKnowledge();
    downloadJSON(json, 'knowledge-base.json');
  });
  $('#btn-importKb').addEventListener('click', () => $('#file-importKb').click());
  $('#file-importKb').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const count = await importKnowledge(await file.text());
      showToast(`Импортировано записей: ${count}`);
      renderKnowledgeList();
    } catch (err) { showToast(`Ошибка: ${err.message}`); }
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
async function restoreState() {
  const { windowPinned = false, windowBoundTabId = null } = await chrome.storage.local.get(['windowPinned', 'windowBoundTabId']);
  isPinned = windowPinned;
  boundTabId = windowBoundTabId;
  if (isPinned) {
    $('#btn-pin').classList.add('pinned');
  }
  if (boundTabId) {
    updateContextBarState('bound', 'привязано');
  }
  // Apply debug mode (default off — debug-only elements hidden by CSS/style)
  applyDebugMode();
}

function requestInitialData() {
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, resp => {
    if (resp?.state?.ticketData) {
      updateTicketCard(resp.state.ticketData);
    }
    if (resp?.state?.accountingData) {
      mergeAccountingData(resp.state.accountingData);
    }
  });

  // Parse active/bound tab
  const parseMsg = boundTabId
    ? { type: 'PARSE_TAB', tabId: boundTabId, parseType: 'PARSE_OTRS' }
    : { type: 'PARSE_ACTIVE_TAB', parseType: 'PARSE_OTRS' };

  chrome.runtime.sendMessage(parseMsg, resp => {
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
        if (msg.key === 'ticketData' && msg.data) updateTicketCard(msg.data);
        if (msg.key === 'accountingData' && msg.data) mergeAccountingData(msg.data);
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
      case 'CONTEXT_CHANGED':
        if (msg.data) updateTicketCard(msg.data);
        break;
    }
  });
}

// === Template Editor ===
function openTemplateEditor(tpl) {
  editingTemplateId = tpl.id;
  $('#tpl-edit-name').value = tpl.name || '';
  $('#tpl-edit-category').value = tpl.category || '';
  $('#tpl-edit-tags').value = (tpl.tags || []).join(', ');
  $('#tpl-edit-body').value = tpl.body || '';
  $('#tpl-edit-panel').classList.remove('hidden');
  $('#tpl-edit-panel').scrollIntoView({ behavior: 'smooth' });
}

function initTemplateEditorButtons() {
  $('#btn-saveTplEdit').addEventListener('click', async () => {
    if (!editingTemplateId) return;
    const updates = {
      name: $('#tpl-edit-name').value.trim(),
      category: $('#tpl-edit-category').value.trim(),
      tags: $('#tpl-edit-tags').value.split(',').map(t => t.trim()).filter(Boolean),
      body: $('#tpl-edit-body').value.trim()
    };
    await updateTemplate(editingTemplateId, updates);
    editingTemplateId = null;
    $('#tpl-edit-panel').classList.add('hidden');
    showToast('Шаблон обновлён');
    renderTemplateList();
  });
  $('#btn-cancelTplEdit').addEventListener('click', () => {
    editingTemplateId = null;
    $('#tpl-edit-panel').classList.add('hidden');
  });
}

// === Debug Mode ===
function initDebugModeHotkey() {
  // Ctrl+Shift+D toggles debug mode
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'D') {
      e.preventDefault();
      toggleDebugMode();
    }
  });
}

function toggleDebugMode() {
  debugMode = !debugMode;
  chrome.runtime.sendMessage({ type: 'SET_DEBUG_MODE', enabled: debugMode });
  applyDebugMode();
  showToast(debugMode ? 'Debug mode ON' : 'Debug mode OFF');
}

function applyDebugMode() {
  $$('.debug-only').forEach(el => {
    el.style.display = debugMode ? '' : 'none';
  });
  // Show/hide unbind button based on state when debug is on
  if (debugMode && boundTabId) {
    $('#btn-unbindTab').style.display = '';
    $('#btn-bindTab').style.display = 'none';
  }
}

// === Runexis Wizard ===
let rxTabId = null;
let rxRunning = false;

function showRunexisWizard() {
  $('#runexisWizard').classList.remove('hidden');
  $('#playbookRunner').classList.add('hidden');
  $('#rxResult').classList.add('hidden');
  $('#rxStatus').textContent = '';
  $('#rxSteps').innerHTML = '';
  $('#rx-city').value = '';
  $('#rx-code').value = '495';
  $('#rx-codeGroup').classList.add('hidden');
  rxRunning = false;

  // Показать/скрыть поле "Код" при вводе "Москва"
  $('#rx-city').oninput = () => {
    const isMoscow = $('#rx-city').value.trim().toLowerCase() === 'москва';
    $('#rx-codeGroup').classList.toggle('hidden', !isMoscow);
  };

  $('#btn-rxStart').onclick = () => runRunexisWizard();
  $('#btn-rxCancel').onclick = () => cancelRunexisWizard();
  $('#btn-rxCopy').onclick = async () => {
    const text = $('#rxResultText').value;
    if (!text) return;
    // Копируем через content script активной вкладки Runexis
    const resp = await sendToRunexisTab({ type: 'RUNEXIS_COPY_TO_CLIPBOARD', text });
    if (resp?.ok) {
      showToast('Номера скопированы в буфер');
    } else {
      // Fallback: прямая попытка (может не сработать из popup)
      try {
        await navigator.clipboard.writeText(text);
        showToast('Номера скопированы в буфер');
      } catch (e) {
        showToast('Не удалось скопировать — выделите текст в поле ниже и нажмите Ctrl+C');
        $('#rxResultText').select();
        $('#rxResultText').focus();
      }
    }
  };
  $('#btn-rxShowResult').onclick = () => {
    // Показать результат для ручного Ctrl+C
    const text = $('#rxResultText').value;
    if (!text) { showToast('Нет результата'); return; }
    $('#rxResult').classList.remove('hidden');
    $('#rxResultText').select();
    $('#rxResultText').focus();
    showToast('Выделите текст и нажмите Ctrl+C для копирования');
  };
  $('#btn-rxInsertOtrs').onclick = () => insertRunexisToOtrs();
  $('#btn-rxReInsert').onclick = () => insertRunexisToOtrs();
  $('#btn-rxClearClipboard').onclick = async () => {
    const resp = await sendToRunexisTab({ type: 'RUNEXIS_COPY_TO_CLIPBOARD', text: '' });
    if (resp?.ok) {
      showToast('Буфер обмена очищен');
    } else {
      try { await navigator.clipboard.writeText(''); showToast('Буфер обмена очищен'); }
      catch (e) { showToast('Не удалось очистить буфер'); }
    }
  };
  $('#btn-rxClearResult').onclick = async () => {
    await sendMsg({ type: 'RUNEXIS_CLEAR_RESULT' });
    $('#rxResultText').value = '';
    $('#rxResultInfo').textContent = '';
    $('#rxResult').classList.add('hidden');
    showToast('Результат очищен');
  };
}

function cancelRunexisWizard() {
  rxRunning = false;
  $('#runexisWizard').classList.add('hidden');
}

function rxAddStep(text, status) {
  const el = document.createElement('div');
  el.className = `step-item step-item--${status}`;
  el.innerHTML = `
    <span class="step-item__num">&bull;</span>
    <span class="step-item__desc">${escapeHtml(text)}</span>
    <span class="step-item__status">${status === 'done' ? 'OK' : status === 'error' ? 'ошибка' : status === 'running' ? '...' : status === 'assist' ? 'ручной' : ''}</span>
  `;
  $('#rxSteps').appendChild(el);
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return el;
}

function rxUpdateStep(el, status, extraText) {
  el.className = `step-item step-item--${status}`;
  const statusEl = el.querySelector('.step-item__status');
  statusEl.textContent = status === 'done' ? 'OK' : status === 'error' ? 'ошибка' : status === 'assist' ? 'ручной' : '';
  if (extraText) {
    const desc = el.querySelector('.step-item__desc');
    desc.textContent += ' — ' + extraText;
  }
}

function rxSetStatus(text) {
  $('#rxStatus').textContent = text;
}

async function runRunexisWizard() {
  const city = $('#rx-city').value.trim();
  if (!city) { showToast('Введите город'); return; }

  const numberType = $('#rx-numberType').value;
  const isMoscow = city.toLowerCase() === 'москва';
  const codeChoice = isMoscow ? $('#rx-code').value : null;

  rxRunning = true;
  $('#rxSteps').innerHTML = '';
  $('#rxResult').classList.add('hidden');
  $('#btn-rxStart').disabled = true;

  addLog('Runexis', `Запуск: ${city}, ${numberType}${isMoscow ? ', код: ' + codeChoice : ''}`, true);

  try {
    // === ШАГ 1: Открыть / найти вкладку Runexis ===
    let step = rxAddStep('Шаг 1: Открываю Runexis...', 'running');
    rxSetStatus('Открываю Runexis...');

    const existing = await sendMsg({ type: 'RUNEXIS_FIND_TAB' });
    if (existing?.ok && existing.tabId) {
      rxTabId = existing.tabId;
      const actResp = await sendMsg({ type: 'RUNEXIS_ACTIVATE_TAB', tabId: rxTabId });
      if (!actResp?.ok) {
        // Вкладка мертва — открываем новую
        const newResp = await sendMsg({ type: 'RUNEXIS_OPEN_TAB', url: 'https://did-trunk.runexis.ru/site/login' });
        if (!newResp?.ok) throw new Error(`Не удалось открыть Runexis: ${newResp?.error || 'неизвестная ошибка'}`);
        rxTabId = newResp.tabId;
        rxUpdateStep(step, 'done', 'новая вкладка');
      } else {
        rxUpdateStep(step, 'done', 'вкладка найдена');
      }
    } else {
      const resp = await sendMsg({ type: 'RUNEXIS_OPEN_TAB', url: 'https://did-trunk.runexis.ru/site/login' });
      if (!resp?.ok) throw new Error(`Не удалось открыть Runexis: ${resp?.error || 'неизвестная ошибка'}`);
      rxTabId = resp.tabId;
      rxUpdateStep(step, 'done', 'новая вкладка');
    }

    // === ШАГ 2: Проверка авторизации ===
    step = rxAddStep('Шаг 2: Проверяю авторизацию...', 'running');
    rxSetStatus('Жду загрузку страницы...');
    await sendMsg({ type: 'RUNEXIS_WAIT_TAB_LOAD', tabId: rxTabId, timeout: 8000 });

    const authCheck = await sendToRunexisTab({ type: 'RUNEXIS_CHECK_AUTH' });
    if (!authCheck?.ok) {
      rxUpdateStep(step, 'error', `Не удалось проверить: ${authCheck?.error || 'content script не ответил'}`);
      throw new Error(`Ошибка авторизации: ${authCheck?.error || 'content script Runexis не ответил. Проверьте разрешения расширения.'}`);
    }

    if (authCheck.isLoginPage) {
      // НЕ пытаемся автологин — сразу пауза для ручного входа
      rxUpdateStep(step, 'assist', 'требуется ручной вход');
      const manualStep = rxAddStep('Войдите вручную в Runexis, затем нажмите "Продолжить"', 'assist');
      rxSetStatus('Войдите вручную в Runexis, затем нажмите "Продолжить"');
      await waitForUserContinue(manualStep);
      // Ждём загрузку после входа
      await sendMsg({ type: 'RUNEXIS_WAIT_TAB_LOAD', tabId: rxTabId, timeout: 5000 });
      rxUpdateStep(step, 'done', 'авторизован');
    } else {
      rxUpdateStep(step, 'done', 'уже авторизован');
    }

    if (!rxRunning) return;

    // === ШАГ 3: Переход на /numbers ===
    step = rxAddStep('Шаг 3: Открываю страницу номеров...', 'running');
    rxSetStatus('Перехожу на /numbers...');
    const navResp = await sendMsg({ type: 'RUNEXIS_NAVIGATE_TAB', tabId: rxTabId, url: 'https://did-trunk.runexis.ru/numbers' });
    if (!navResp?.ok) throw new Error(`Ошибка навигации: ${navResp?.error || 'unknown'}`);
    await sendMsg({ type: 'RUNEXIS_WAIT_TAB_LOAD', tabId: rxTabId, timeout: 10000 });
    rxUpdateStep(step, 'done');

    // Определяем проходы
    const codes = isMoscow && codeChoice === 'both' ? ['495', '499'] : [codeChoice];
    let allNumbers = [];

    for (const code of codes) {
      if (!rxRunning) return;

      const passLabel = codes.length > 1 ? ` (код ${code})` : '';

      // === ШАГ 4: Фильтры (очистка + установка) ===
      step = rxAddStep(`Шаг 4: Фильтры${passLabel}...`, 'running');
      rxSetStatus(`Очищаю + заполняю фильтры${passLabel}...`);
      await delay(500);
      const filterResp = await sendToRunexisTab({ type: 'RUNEXIS_SET_FILTERS', city, numberType, code });
      if (!filterResp?.ok) {
        rxUpdateStep(step, 'error', `Ошибка фильтров: ${filterResp?.error || 'content script не ответил'}`);
      } else {
        const d = filterResp.diagnostics || {};
        const details = [];
        if (d.cityValue) details.push(`город: ${d.cityValue}`);
        else if (d.citySet) details.push(`город: ${city} (установлен)`);
        if (d.typeValue) details.push(`тип: ${d.typeValue}`);
        if (d.codeValue) details.push(`код: ${d.codeValue}`);
        rxUpdateStep(step, 'done', details.join(', ') || 'OK');
      }

      // === ШАГ 5: Применить ===
      step = rxAddStep(`Шаг 5: Применяю${passLabel}...`, 'running');
      rxSetStatus(`Нажимаю "Применить"${passLabel}...`);
      await delay(700);
      const applyResp = await sendToRunexisTab({ type: 'RUNEXIS_APPLY_FILTERS' });
      if (!applyResp?.ok) {
        rxUpdateStep(step, 'error', `Кнопка: ${applyResp?.error || 'не найдена'}`);
      } else {
        rxUpdateStep(step, 'done');
      }

      // Ждём результаты
      await sendMsg({ type: 'RUNEXIS_WAIT_TAB_LOAD', tabId: rxTabId, timeout: 10000 });
      await delay(1000);

      // === ШАГ 6: Пагинация ===
      step = rxAddStep(`Шаг 6: Пагинация${passLabel}...`, 'running');
      rxSetStatus(`Определяю пагинацию${passLabel}...`);
      const pagInfo = await sendToRunexisTab({ type: 'RUNEXIS_GET_PAGINATION_INFO' });
      let targetPage = 1;
      if (pagInfo?.ok) {
        if (pagInfo.maxPage >= 2) targetPage = 2;
      }

      if (targetPage > 1) {
        const goResp = await sendToRunexisTab({ type: 'RUNEXIS_GO_TO_PAGE', page: targetPage });
        if (!goResp?.ok) {
          rxUpdateStep(step, 'error', `Страница ${targetPage}: ${goResp?.error || 'не найдена'}`);
          targetPage = 1; // остаёмся на текущей
        } else {
          await sendMsg({ type: 'RUNEXIS_WAIT_TAB_LOAD', tabId: rxTabId, timeout: 8000 });
          await delay(800);
        }
      }
      rxUpdateStep(step, 'done', `стр. ${targetPage} из ${pagInfo?.maxPage || '?'}`);

      // === ШАГ 7: Сбор номеров ===
      step = rxAddStep(`Шаг 7: Сбор номеров${passLabel}...`, 'running');
      rxSetStatus(`Собираю номера${passLabel}...`);
      const collectResp = await sendToRunexisTab({ type: 'RUNEXIS_COLLECT_NUMBERS' });
      if (!collectResp?.ok) {
        rxUpdateStep(step, 'error', `Ошибка сбора: ${collectResp?.error || 'content script не ответил'}`);
      } else if (collectResp.numbers?.length > 0) {
        rxUpdateStep(step, 'done', `${collectResp.numbers.length} номеров на стр. ${targetPage}`);
        allNumbers = allNumbers.concat(collectResp.numbers);
      } else {
        rxUpdateStep(step, 'error', 'Номера не найдены на странице');
      }
    }

    // Дедупликация
    allNumbers = [...new Set(allNumbers)];

    if (allNumbers.length === 0) {
      rxSetStatus('Номера не найдены');
      showToast('Номера не найдены');
      return;
    }

    // Сохраняем и копируем (через content script — обход ошибки "Document is not focused")
    const resultText = allNumbers.join('\n');
    await sendMsg({ type: 'RUNEXIS_STORE_RESULT', numbers: allNumbers });
    const copyResp = await sendToRunexisTab({ type: 'RUNEXIS_COPY_TO_CLIPBOARD', text: resultText });
    const copied = copyResp?.ok;

    // Показываем результат
    $('#rxResult').classList.remove('hidden');
    $('#rxResultInfo').textContent = copied
      ? `Готово: ${allNumbers.length} номеров, скопировано в буфер`
      : `Готово: ${allNumbers.length} номеров (буфер: не удалось — используйте "Показать результат" для ручного копирования)`;
    $('#rxResultText').value = resultText;

    // Проверяем OTRS editor
    await checkOtrsEditorAvailable();

    rxSetStatus(`Готово: ${allNumbers.length} номеров`);
    showToast(copied
      ? `Готово: ${allNumbers.length} номеров, скопировано в буфер`
      : `Готово: ${allNumbers.length} номеров (буфер обмена недоступен — нажмите "Показать результат")`);
    addLog('Runexis', `Подобрано ${allNumbers.length} номеров для ${city}`, true);

  } catch (err) {
    rxSetStatus(`Ошибка: ${err.message}`);
    showToast(`Ошибка Runexis: ${err.message}`);
    addLog('Runexis', `Ошибка: ${err.message}`, false);
  } finally {
    rxRunning = false;
    $('#btn-rxStart').disabled = false;
  }
}

async function checkOtrsEditorAvailable() {
  const resp = await sendMsg({ type: 'RUNEXIS_CHECK_OTRS_EDITOR' });
  const btn = $('#btn-rxInsertOtrs');
  if (resp?.ok && resp.available) {
    btn.disabled = false;
    btn.title = 'Вставить номера в OTRS';
  } else {
    btn.disabled = true;
    btn.title = 'Откройте окно ответа/заметки в OTRS';
  }
}

async function insertRunexisToOtrs() {
  const text = $('#rxResultText').value;
  if (!text) { showToast('Нет данных для вставки'); return; }

  const resp = await sendMsg({ type: 'RUNEXIS_INSERT_OTRS', text });
  if (resp?.ok) {
    showToast('Номера вставлены в OTRS');
    addLog('Runexis', 'Номера вставлены в OTRS', true);
  } else {
    showToast(`Ошибка вставки: ${resp?.error || 'OTRS вкладка не найдена'}`);
    const copyFb = await sendToRunexisTab({ type: 'RUNEXIS_COPY_TO_CLIPBOARD', text });
    if (copyFb?.ok) {
      showToast('Скопировано в буфер (OTRS не найден)');
    } else {
      showToast('OTRS не найден. Используйте "Показать результат" для ручного копирования.');
    }
  }
}

function waitForUserContinue(stepEl) {
  return new Promise((resolve) => {
    const bar = document.createElement('div');
    bar.className = 'confirm-bar';
    bar.innerHTML = `
      <span class="confirm-bar__text">Нажмите после входа:</span>
      <button class="btn btn--primary">Продолжить</button>
    `;
    bar.querySelector('.btn--primary').addEventListener('click', () => {
      bar.remove();
      resolve();
    });
    stepEl.appendChild(bar);
  });
}

function sendMsg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, resp => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp);
      }
    });
  });
}

function sendToRunexisTab(msg) {
  return new Promise((resolve) => {
    if (!rxTabId) { resolve({ ok: false, error: 'Нет вкладки Runexis (tabId не задан)' }); return; }
    chrome.runtime.sendMessage({ type: 'RUNEXIS_SEND_TO_TAB', tabId: rxTabId, message: msg }, resp => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp);
      }
    });
  });
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
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
