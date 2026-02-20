/**
 * Knowledge Base — заметки с тегами, полнотекстовый поиск.
 * { id, title, text, tags: [], createdAt }
 * Хранение в chrome.storage.local под ключом 'knowledgeBase'.
 */

export async function addKnowledgeEntry(entry) {
  const record = {
    id: crypto.randomUUID(),
    title: entry.title || '',
    text: entry.text || '',
    tags: entry.tags || [],
    createdAt: new Date().toISOString()
  };

  const { knowledgeBase = [] } = await chrome.storage.local.get('knowledgeBase');
  knowledgeBase.push(record);
  await chrome.storage.local.set({ knowledgeBase });
  return record;
}

export async function getKnowledgeEntries() {
  const { knowledgeBase = [] } = await chrome.storage.local.get('knowledgeBase');
  return knowledgeBase;
}

export async function deleteKnowledgeEntry(id) {
  const { knowledgeBase = [] } = await chrome.storage.local.get('knowledgeBase');
  await chrome.storage.local.set({ knowledgeBase: knowledgeBase.filter(e => e.id !== id) });
}

export async function updateKnowledgeEntry(id, updates) {
  const { knowledgeBase = [] } = await chrome.storage.local.get('knowledgeBase');
  const idx = knowledgeBase.findIndex(e => e.id === id);
  if (idx >= 0) {
    knowledgeBase[idx] = { ...knowledgeBase[idx], ...updates };
    await chrome.storage.local.set({ knowledgeBase });
    return knowledgeBase[idx];
  }
  return null;
}

export function searchKnowledge(entries, query) {
  if (!query || !query.trim()) return entries;
  const lower = query.toLowerCase();
  const terms = lower.split(/\s+/).filter(Boolean);

  return entries
    .map(entry => {
      const haystack = `${entry.title} ${entry.text} ${entry.tags.join(' ')}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (haystack.includes(term)) score++;
      }
      return { entry, score };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(r => r.entry);
}

export async function exportKnowledge() {
  const entries = await getKnowledgeEntries();
  return JSON.stringify(entries, null, 2);
}

export async function importKnowledge(jsonStr) {
  const imported = JSON.parse(jsonStr);
  if (!Array.isArray(imported)) throw new Error('Ожидается массив JSON');
  const { knowledgeBase = [] } = await chrome.storage.local.get('knowledgeBase');
  const merged = [...knowledgeBase, ...imported.map(e => ({
    ...e,
    id: e.id || crypto.randomUUID(),
    createdAt: e.createdAt || new Date().toISOString()
  }))];
  await chrome.storage.local.set({ knowledgeBase: merged });
  return merged.length;
}
