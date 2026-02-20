/**
 * Playbook engine — исполнение сценариев в двух режимах:
 * - Assist: показывает ссылки/кнопки, копипаст значений, не выполняет действий.
 * - Automate: выполняет шаги по подтверждению. Если элемент не найден — fallback в Assist.
 *
 * Каждый шаг: { id, type, description, system, action, params, waitForConfirm }
 * action: 'navigate' | 'parse' | 'fill' | 'click' | 'extract' | 'custom'
 */

export const MODE_ASSIST = 'assist';
export const MODE_AUTOMATE = 'automate';

export class PlaybookEngine {
  constructor() {
    this.mode = MODE_ASSIST;
    this.currentPlaybook = null;
    this.currentStepIndex = -1;
    this.context = {};        // собранные данные: clientCode, lineNumber, etc.
    this.stepResults = [];
    this.onStepUpdate = null; // callback(stepIndex, status, data)
    this.onConfirmNeeded = null; // callback(stepIndex, step) => Promise<bool>
    this.onLog = null;        // callback(system, action, ok, error)
    this.onModeFallback = null; // callback(stepIndex, reason)
  }

  setMode(mode) {
    this.mode = mode;
  }

  async loadPlaybook(playbook) {
    this.currentPlaybook = playbook;
    this.currentStepIndex = -1;
    this.stepResults = playbook.steps.map(() => ({ status: 'pending', data: null }));
    this.context = {};
  }

  async runNext() {
    if (!this.currentPlaybook) return null;
    this.currentStepIndex++;
    if (this.currentStepIndex >= this.currentPlaybook.steps.length) {
      return { done: true };
    }
    const step = this.currentPlaybook.steps[this.currentStepIndex];
    return this.executeStep(this.currentStepIndex, step);
  }

  async executeStep(index, step) {
    const result = { status: 'pending', data: null, error: null };
    this.notify(index, 'running', null);

    try {
      // В Assist mode — только показываем что нужно сделать
      if (this.mode === MODE_ASSIST && step.action !== 'extract' && step.action !== 'parse') {
        result.status = 'assist';
        result.data = this.buildAssistData(step);
        this.stepResults[index] = result;
        this.notify(index, 'assist', result.data);
        this.log(step.system, step.description, true);
        return result;
      }

      // Подтверждение
      if (step.waitForConfirm !== false && this.onConfirmNeeded) {
        const confirmed = await this.onConfirmNeeded(index, step);
        if (!confirmed) {
          result.status = 'skipped';
          this.stepResults[index] = result;
          this.notify(index, 'skipped', null);
          return result;
        }
      }

      // Выполнение
      switch (step.action) {
        case 'navigate':
          result.data = await this.doNavigate(step);
          break;
        case 'parse':
          result.data = await this.doParse(step);
          break;
        case 'fill':
          result.data = await this.doFill(step);
          break;
        case 'click':
          result.data = await this.doClick(step);
          break;
        case 'extract':
          result.data = await this.doExtract(step);
          break;
        default:
          throw new Error(`Неизвестное действие: ${step.action}`);
      }

      result.status = 'done';
      this.stepResults[index] = result;
      this.notify(index, 'done', result.data);
      this.log(step.system, step.description, true);
    } catch (err) {
      result.status = 'error';
      result.error = err.message;
      this.stepResults[index] = result;
      this.notify(index, 'error', err.message);
      this.log(step.system, step.description, false, err.message);

      // Automate mode fallback
      if (this.mode === MODE_AUTOMATE) {
        this.mode = MODE_ASSIST;
        if (this.onModeFallback) {
          this.onModeFallback(index, err.message);
        }
      }
    }

    return result;
  }

  buildAssistData(step) {
    const data = { description: step.description };

    if (step.action === 'navigate') {
      const url = this.resolveTemplate(step.params?.url || '');
      data.link = url;
      data.label = `Открыть: ${step.system}`;
    }

    if (step.action === 'fill') {
      data.copyValue = this.resolveTemplate(step.params?.value || '');
      data.label = `Вставить: ${data.copyValue}`;
    }

    if (step.action === 'click') {
      data.label = `Нажать: ${step.params?.buttonText || step.description}`;
    }

    return data;
  }

  async doNavigate(step) {
    const url = this.resolveTemplate(step.params?.url || '');
    // Отправляем команду background для открытия вкладки
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'OPEN_TAB', url, activate: step.params?.activate !== false },
        resp => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve({ tabId: resp?.tabId, url });
          }
        }
      );
    });
  }

  async doParse(step) {
    const msgType = step.params?.parseMessage;
    const tabId = step.params?.tabId || await this.findTabByPattern(step.params?.urlPattern);
    if (!tabId) throw new Error(`Вкладка не найдена: ${step.params?.urlPattern}`);

    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, { type: msgType }, resp => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!resp?.ok) {
          reject(new Error(resp?.error || 'Ошибка парсинга'));
          return;
        }
        // Merge parsed data into context
        if (resp.data) {
          Object.assign(this.context, resp.data);
        }
        resolve(resp.data);
      });
    });
  }

  async doFill(step) {
    const tabId = step.params?.tabId || await this.findTabByPattern(step.params?.urlPattern);
    if (!tabId) throw new Error(`Вкладка не найдена: ${step.params?.urlPattern}`);

    const value = this.resolveTemplate(step.params?.value || '');
    const msgType = step.params?.fillMessage;

    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(
        tabId,
        { type: msgType, ...step.params?.extra, value, lineNumber: value },
        resp => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!resp?.ok) {
            reject(new Error(resp?.error || 'Ошибка заполнения'));
            return;
          }
          resolve(resp);
        }
      );
    });
  }

  async doClick(step) {
    const tabId = step.params?.tabId || await this.findTabByPattern(step.params?.urlPattern);
    if (!tabId) throw new Error(`Вкладка не найдена: ${step.params?.urlPattern}`);

    const msgType = step.params?.clickMessage;
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, { type: msgType, ...step.params?.extra }, resp => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!resp?.ok) {
          reject(new Error(resp?.error || 'Ошибка нажатия'));
          return;
        }
        resolve(resp);
      });
    });
  }

  async doExtract(step) {
    // Извлечение данных (аналогично parse) с сохранением в context
    return this.doParse(step);
  }

  resolveTemplate(template) {
    return template.replace(/\{(\w+)\}/g, (_, key) => {
      return this.context[key] || `{${key}}`;
    });
  }

  async findTabByPattern(urlPattern) {
    if (!urlPattern) return null;
    return new Promise(resolve => {
      chrome.runtime.sendMessage(
        { type: 'FIND_TAB', urlPattern },
        resp => resolve(resp?.tabId || null)
      );
    });
  }

  notify(index, status, data) {
    if (this.onStepUpdate) this.onStepUpdate(index, status, data);
  }

  log(system, action, ok, error = '') {
    if (this.onLog) this.onLog(system, action, ok, error);
  }

  getStatus() {
    return {
      mode: this.mode,
      playbook: this.currentPlaybook?.name || null,
      currentStep: this.currentStepIndex,
      totalSteps: this.currentPlaybook?.steps?.length || 0,
      context: { ...this.context },
      results: [...this.stepResults]
    };
  }
}
