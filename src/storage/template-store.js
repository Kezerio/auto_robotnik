/**
 * Template store — шаблоны ответов OTRS.
 * { id, name, category, tags:[], body (HTML/text), placeholders, createdAt }
 * + обучение: templateUsages — связка "признаки тикета → выбранный шаблон"
 */

export async function addTemplate(template) {
  const record = {
    id: crypto.randomUUID(),
    name: template.name || 'Без названия',
    category: template.category || '',
    tags: template.tags || [],
    body: template.body || '',
    placeholders: extractPlaceholders(template.body || ''),
    createdAt: new Date().toISOString()
  };

  const { templates = [] } = await chrome.storage.local.get('templates');
  templates.push(record);
  await chrome.storage.local.set({ templates });
  return record;
}

export async function updateTemplate(id, updates) {
  const { templates = [] } = await chrome.storage.local.get('templates');
  const idx = templates.findIndex(t => t.id === id);
  if (idx >= 0) {
    templates[idx] = { ...templates[idx], ...updates };
    if (updates.body) {
      templates[idx].placeholders = extractPlaceholders(updates.body);
    }
    await chrome.storage.local.set({ templates });
    return templates[idx];
  }
  return null;
}

export async function deleteTemplate(id) {
  const { templates = [] } = await chrome.storage.local.get('templates');
  await chrome.storage.local.set({ templates: templates.filter(t => t.id !== id) });
}

export async function getTemplates() {
  const { templates = [] } = await chrome.storage.local.get('templates');
  return templates;
}

export function searchTemplates(templates, query) {
  if (!query || !query.trim()) return templates;
  const lower = query.toLowerCase();
  const terms = lower.split(/\s+/).filter(Boolean);
  return templates
    .map(t => {
      const haystack = `${t.name} ${t.category} ${t.tags.join(' ')} ${t.body}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (haystack.includes(term)) score++;
      }
      return { template: t, score };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(r => r.template);
}

/** Подставить значения контекста в плейсхолдеры шаблона */
export function resolveTemplatePlaceholders(body, context) {
  return body.replace(/\{([A-Z_]+)\}/g, (match, key) => {
    const map = {
      CLIENT_CODE: context.clientCode,
      TICKET_NUMBER: context.ticketId || context.ticketNumber,
      LINE_NUMBER: context.lineNumber || (context.lineNumbers || [])[0],
      CLIENT_NAME: context.clientName,
      ATC_PLAN: context.atcPlan
    };
    return map[key] || match;
  });
}

function extractPlaceholders(body) {
  const matches = body.match(/\{[A-Z_]+\}/g) || [];
  return [...new Set(matches)];
}

// === Обучение шаблонам: запоминание связки "тикет → шаблон" ===

export async function recordTemplateUsage(ticketMeta, templateId) {
  const record = {
    ts: new Date().toISOString(),
    templateId,
    ticketId: ticketMeta.ticketId || '',
    clientCode: ticketMeta.clientCode || '',
    queue: ticketMeta.queue || '',
    subject: ticketMeta.subject || '',
    keywords: ticketMeta.keywords || []
  };
  const { templateUsages = [] } = await chrome.storage.local.get('templateUsages');
  templateUsages.push(record);
  if (templateUsages.length > 2000) {
    templateUsages.splice(0, templateUsages.length - 2000);
  }
  await chrome.storage.local.set({ templateUsages });
}

/** Рекомендовать шаблоны на основе истории использования */
export async function getRecommendedTemplates(ticketMeta, allTemplates, limit = 3) {
  const { templateUsages = [] } = await chrome.storage.local.get('templateUsages');
  if (templateUsages.length === 0) return [];

  // Подсчёт частоты использования шаблонов (с приоритетом похожих тикетов)
  const scores = {};
  for (const usage of templateUsages) {
    let relevance = 1;
    if (ticketMeta.clientCode && usage.clientCode === ticketMeta.clientCode) relevance += 2;
    if (ticketMeta.queue && usage.queue === ticketMeta.queue) relevance += 3;
    if (ticketMeta.keywords) {
      for (const kw of ticketMeta.keywords) {
        if (usage.keywords.includes(kw)) relevance += 1;
      }
    }
    scores[usage.templateId] = (scores[usage.templateId] || 0) + relevance;
  }

  return allTemplates
    .filter(t => scores[t.id])
    .sort((a, b) => (scores[b.id] || 0) - (scores[a.id] || 0))
    .slice(0, limit);
}

export async function exportTemplates() {
  const templates = await getTemplates();
  return JSON.stringify(templates, null, 2);
}

export async function importTemplates(jsonStr) {
  const imported = JSON.parse(jsonStr);
  if (!Array.isArray(imported)) throw new Error('Ожидается массив JSON');
  const { templates = [] } = await chrome.storage.local.get('templates');
  const merged = [...templates, ...imported.map(t => ({
    ...t,
    id: t.id || crypto.randomUUID(),
    createdAt: t.createdAt || new Date().toISOString()
  }))];
  await chrome.storage.local.set({ templates: merged });
  return merged.length;
}
