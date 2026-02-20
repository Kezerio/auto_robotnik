/**
 * Training examples store — обучающие примеры:
 * { ticketText, metadata, chosenCase, params, result (OK/NOT_OK), corrections }
 * Хранение в chrome.storage.local под ключом 'trainingExamples'.
 */

export async function addTrainingExample(example) {
  const record = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    ticketText: example.ticketText || '',
    metadata: example.metadata || {},
    chosenCase: example.chosenCase || '',
    params: example.params || {},
    result: example.result || 'OK',
    corrections: example.corrections || ''
  };

  const { trainingExamples = [] } = await chrome.storage.local.get('trainingExamples');
  trainingExamples.push(record);
  await chrome.storage.local.set({ trainingExamples });
  return record;
}

export async function getTrainingExamples() {
  const { trainingExamples = [] } = await chrome.storage.local.get('trainingExamples');
  return trainingExamples;
}

export async function deleteTrainingExample(id) {
  const { trainingExamples = [] } = await chrome.storage.local.get('trainingExamples');
  const filtered = trainingExamples.filter(e => e.id !== id);
  await chrome.storage.local.set({ trainingExamples: filtered });
}

export async function exportTrainingExamples() {
  const examples = await getTrainingExamples();
  return JSON.stringify(examples, null, 2);
}

export async function importTrainingExamples(jsonStr) {
  const imported = JSON.parse(jsonStr);
  if (!Array.isArray(imported)) throw new Error('Ожидается массив JSON');
  const { trainingExamples = [] } = await chrome.storage.local.get('trainingExamples');
  const merged = [...trainingExamples, ...imported.map(e => ({
    ...e,
    id: e.id || crypto.randomUUID(),
    ts: e.ts || new Date().toISOString()
  }))];
  await chrome.storage.local.set({ trainingExamples: merged });
  return merged.length;
}
