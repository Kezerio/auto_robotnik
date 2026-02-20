/**
 * Logging system — каждый шаг пишет запись:
 * timestamp, system, action, success/error, errorText
 * Хранение в chrome.storage.local под ключом 'logs'.
 */

const MAX_LOG_ENTRIES = 5000;

export async function addLog(system, action, success, errorText = '') {
  const entry = {
    ts: new Date().toISOString(),
    system,
    action,
    ok: success,
    error: errorText
  };

  const { logs = [] } = await chrome.storage.local.get('logs');
  logs.push(entry);
  if (logs.length > MAX_LOG_ENTRIES) {
    logs.splice(0, logs.length - MAX_LOG_ENTRIES);
  }
  await chrome.storage.local.set({ logs });
  return entry;
}

export async function getLogs(limit = 200) {
  const { logs = [] } = await chrome.storage.local.get('logs');
  return logs.slice(-limit);
}

export async function clearLogs() {
  await chrome.storage.local.set({ logs: [] });
}

export async function exportLogs() {
  const { logs = [] } = await chrome.storage.local.get('logs');
  return JSON.stringify(logs, null, 2);
}
