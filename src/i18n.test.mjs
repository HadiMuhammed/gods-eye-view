import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveLocale, getTranslations, applyTranslations, setLocale, t } from './i18n.js';

test('resolveLocale falls back to English for unsupported locales', () => {
  assert.equal(resolveLocale('zh'), 'en');
  assert.equal(resolveLocale('es'), 'es');
});

test('translations include a non-English value for the title', () => {
  const translations = getTranslations();
  assert.equal(translations.en.appTitle, "GOD'S EYE VIEW");
  assert.equal(translations.es.appTitle, 'VISTA DEL OJO DE DIOS');
});

test('applyTranslations updates DOM text and html lang', () => {
  const items = [
    { dataset: { i18n: 'appTitle' }, textContent: 'old' },
    { dataset: { i18n: 'subtitle' }, textContent: 'old' },
  ];
  const root = {
    documentElement: { lang: 'en' },
    querySelectorAll: (selector) => {
      if (selector === '[data-i18n]') return items;
      return [];
    },
  };

  applyTranslations(root, 'es');

  assert.equal(root.documentElement.lang, 'es');
  assert.equal(items[0].textContent, 'VISTA DEL OJO DE DIOS');
  assert.equal(items[1].textContent, 'NINGÚN LUGAR QUEDÓ ATRÁS');
});

test('setLocale persists the current locale and resolves fallback keys', () => {
  const original = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => 'fr', setItem: () => {} };

  try {
    assert.equal(setLocale('fr', { skipApply: true }), 'fr');
    assert.equal(t('appTitle', 'fr'), "VUE DE L'OEIL DE DIEU");
  } finally {
    globalThis.localStorage = original;
  }
});
