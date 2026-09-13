import { getCurrentLocale } from './i18n.js';

const CACHE_KEY = 'gev-auto-translation-v1';
const MAX_CACHE_ENTRIES = 500;
const MAX_TEXT_LENGTH = 1200;
const BATCH_SIZE = 24;
const pendingOriginals = new WeakMap();

function readCache(storage) {
  try {
    storage ||= globalThis.localStorage;
    const parsed = JSON.parse(storage?.getItem?.(CACHE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeCache(cache, storage) {
  try {
    storage ||= globalThis.localStorage;
    const entries = Object.entries(cache).slice(-MAX_CACHE_ENTRIES);
    storage?.setItem?.(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Caching is an optimization; translation still works without storage.
  }
}

function isTranslatableTextNode(node) {
  const parent = node.parentElement;
  if (!parent || !node.nodeValue?.trim()) return false;
  if (node.nodeValue.trim().length > MAX_TEXT_LENGTH) return false;
  if (parent.closest('[data-i18n], [data-no-translate], [data-locale], [data-language-menu]')) return false;
  if (parent.closest('script, style, svg, canvas, code, pre, input, textarea, select, option')) return false;
  if (parent.closest('.material-symbols-outlined, .data-icon, .data-name, #scene-panel, .scene-shot-actions')) return false;
  return true;
}

function originalText(node) {
  if (!pendingOriginals.has(node)) pendingOriginals.set(node, node.nodeValue);
  return pendingOriginals.get(node);
}

async function requestTranslations(texts, target) {
  const response = await fetch('/api/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'en', target, texts }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`translation_${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload?.texts) || payload.texts.length !== texts.length) {
    throw new Error('invalid_translation_payload');
  }
  return payload.texts;
}

/**
 * Translate dynamic page text through the optional server proxy.
 * Catalog-managed text and protected identifiers are intentionally excluded.
 */
export function initializeAutoTranslation(root = document) {
  if (!root?.body || root.body.dataset.autoTranslatePage !== 'true') return () => {};

  let disposed = false;
  let timer = null;
  let running = false;
  const cache = readCache();

  const translate = async () => {
    if (disposed || running) return;
    const target = getCurrentLocale();
    if (!target || target === 'en') return;
    running = true;
    try {
      const nodes = [];
      const walker = root.createTreeWalker(root.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (isTranslatableTextNode(walker.currentNode)) nodes.push(walker.currentNode);
      }
      const missing = [];
      const missingNodes = [];
      for (const node of nodes) {
        const source = originalText(node).trim();
        const key = `${target}\u0000${source}`;
        if (cache[key] && node.nodeValue !== cache[key]) node.nodeValue = cache[key];
        else if (!missing.includes(source)) {
          missing.push(source);
          missingNodes.push(node);
        }
      }
      for (let index = 0; index < missing.length; index += BATCH_SIZE) {
        const batch = missing.slice(index, index + BATCH_SIZE);
        const translated = await requestTranslations(batch, target);
        translated.forEach((value, offset) => {
          const source = batch[offset];
          cache[`${target}\u0000${source}`] = value;
          for (const node of missingNodes) {
            if (originalText(node).trim() === source) node.nodeValue = value;
          }
        });
      }
      if (missing.length) writeCache(cache);
    } catch {
      // The original English text remains visible when translation is unavailable.
    } finally {
      running = false;
    }
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(translate, 250);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(root.body, { childList: true, subtree: true, characterData: true });
  root.defaultView?.addEventListener('gev:localechange', () => {
    const walker = root.createTreeWalker(root.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (pendingOriginals.has(node) && node.nodeValue !== pendingOriginals.get(node)) {
        node.nodeValue = pendingOriginals.get(node);
      }
    }
    schedule();
  });
  schedule();
  return () => {
    disposed = true;
    clearTimeout(timer);
    observer.disconnect();
  };
}
