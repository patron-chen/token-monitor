'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const proxyI18n = require('../../src/electron/renderer/proxyI18n');

test('proxy translations load separately for every locale', () => {
  const i18n = require('../../src/electron/renderer/i18n');
  proxyI18n.apply(i18n);
  for (const locale of Object.keys(i18n.MESSAGES)) {
    assert.notEqual(i18n.translate(locale, 'settings.proxy.title'), 'settings.proxy.title');
  }
});
