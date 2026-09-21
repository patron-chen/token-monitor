'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createProxyRuntime } = require('../../src/electron/proxyRuntime');
const { createProxySettingsPanel, installMarkup } = require('../../src/electron/renderer/proxySettingsPanel');

function fakeElement() {
  const listeners = new Map();
  return {
    value: '', disabled: false, textContent: '',
    classList: { toggle() {} },
    addEventListener(type, callback) { listeners.set(type, callback); },
    async dispatch(type) { return listeners.get(type)?.(); }
  };
}

test('proxy form keeps a saved password unless explicitly cleared', async () => {
  const nodes = new Map();
  const document = { getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, fakeElement());
    return nodes.get(id);
  } };
  const settings = { proxyMode: 'custom', proxyUrl: 'http://proxy.test:8080', proxyPasswordConfigured: true };
  const writes = [];
  const panel = createProxySettingsPanel({
    document,
    api: { testProxy: async () => ({ ok: true, code: 'success' }) },
    translate: (key) => key,
    getSettings: () => settings,
    saveSettings: async (patch) => { writes.push(patch); Object.assign(settings, patch); },
    renderSettingsSummaries: () => {}
  });
  panel.syncProxyDraftUi();
  assert.equal(nodes.get('proxyPasswordInput').value, '');
  nodes.get('proxyUrlInput').value = 'http://next.test:8080';
  nodes.get('proxyUrlInput').dispatch('input');
  await nodes.get('proxyApplyButton').dispatch('click');
  assert.equal(Object.hasOwn(writes[0], 'proxyPassword'), false);
  await nodes.get('proxyClearPasswordButton').dispatch('click');
  assert.deepEqual(writes[1], { proxyPassword: '' });
});

test('proxy form markup mounts next to startup before app initialization', () => {
  let markup = '';
  installMarkup({ getElementById(id) {
    assert.equal(id, 'startupGroup');
    return { insertAdjacentHTML(position, html) {
      assert.equal(position, 'afterend');
      markup = html;
    } };
  } });
  assert.match(markup, /id="proxyModeInput"/);
  assert.match(markup, /id="proxyPasswordInput" type="password"/);
});

test('proxy runtime routes requests through the selected session and rolls back failed apply', async () => {
  const calls = [];
  let failNext = false;
  const targetSession = {
    async setProxy(config) { calls.push(config); if (failNext) { failNext = false; throw new Error('rejected'); } },
    async closeAllConnections() {},
    async fetch(_url, init) { calls.push(init); return { ok: true }; }
  };
  const runtime = createProxyRuntime({
    net: { fetch: async () => ({ ok: true }), request() {} },
    sessionFactory: () => targetSession,
    env: {}
  });
  await runtime.start({ proxyMode: 'direct' });
  await runtime.limitsFetch('https://provider.test');
  assert.equal(calls.at(-1).credentials, 'omit');
  failNext = true;
  let restored = false;
  await assert.rejects(() => runtime.applySaved(
    { proxyMode: 'custom', proxyUrl: 'http://proxy.test:8080' },
    () => { restored = true; }
  ), /Could not apply proxy settings/);
  assert.equal(restored, true);
  assert.deepEqual(calls.at(-1), { mode: 'direct' });
});
