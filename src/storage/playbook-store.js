/**
 * Playbook store — сохранённые сценарии (записанные и предустановленные).
 * Каждый playbook: { id, name, steps: [ { selector, action, value?, waitFor? } ], createdAt }
 * Хранение в chrome.storage.local под ключом 'playbooks'.
 */

export async function savePlaybook(playbook) {
  const record = {
    id: playbook.id || crypto.randomUUID(),
    name: playbook.name || 'Без названия',
    steps: playbook.steps || [],
    createdAt: playbook.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const { playbooks = [] } = await chrome.storage.local.get('playbooks');
  const idx = playbooks.findIndex(p => p.id === record.id);
  if (idx >= 0) {
    playbooks[idx] = record;
  } else {
    playbooks.push(record);
  }
  await chrome.storage.local.set({ playbooks });
  return record;
}

export async function getPlaybooks() {
  const { playbooks = [] } = await chrome.storage.local.get('playbooks');
  return playbooks;
}

export async function getPlaybook(id) {
  const playbooks = await getPlaybooks();
  return playbooks.find(p => p.id === id) || null;
}

export async function deletePlaybook(id) {
  const { playbooks = [] } = await chrome.storage.local.get('playbooks');
  await chrome.storage.local.set({ playbooks: playbooks.filter(p => p.id !== id) });
}

export async function exportPlaybooks() {
  const playbooks = await getPlaybooks();
  return JSON.stringify(playbooks, null, 2);
}

export async function importPlaybooks(jsonStr) {
  const imported = JSON.parse(jsonStr);
  if (!Array.isArray(imported)) throw new Error('Ожидается массив JSON');
  const { playbooks = [] } = await chrome.storage.local.get('playbooks');
  for (const pb of imported) {
    const existing = playbooks.findIndex(p => p.id === pb.id);
    if (existing >= 0) {
      playbooks[existing] = { ...pb, updatedAt: new Date().toISOString() };
    } else {
      playbooks.push({ ...pb, id: pb.id || crypto.randomUUID() });
    }
  }
  await chrome.storage.local.set({ playbooks });
  return playbooks.length;
}
