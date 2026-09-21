'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CredentialStore, credentialSettingsForRenderer, stripCredentialSettings } = require('../../src/shared/credentialStore');
const { createCredentialCommands } = require('../../src/electron/limits/credentialCommands');

test('proxy passwords stay in the network credential store and out of settings projections', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-proxy-credentials-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new CredentialStore(dataDir);
  const settings = { proxyMode: 'custom', proxyPassword: 'proxy-secret', deepseekApiKey: 'provider-secret' };
  store.replaceSettingsCredentials(settings);
  const document = store.readDocument();
  assert.equal(document.credentials.network.proxyPassword, 'proxy-secret');
  assert.equal(store.settingsCredentials().proxyPassword, 'proxy-secret');
  assert.deepEqual(stripCredentialSettings(settings), { proxyMode: 'custom' });
  assert.equal(credentialSettingsForRenderer(settings).proxyPassword, '');
  assert.equal(credentialSettingsForRenderer(settings).deepseekApiKey, '');
});

function commands(applySettingsPatch) {
  return createCredentialCommands({
    getSettings: () => ({ limitProviders: 'deepseek' }),
    applySettingsPatch,
    probeDeps: () => ({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => '' },
        json: async () => ({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '4.61' }] })
      }),
      readJson: () => ({})
    }),
    env: {}
  });
}

test('credential save and clear return resolved settings after asynchronous proxy-capable updates', async () => {
  const api = commands(async () => ({ projected: true }));
  const saved = await api.saveCredential('deepseek', { deepseekApiKey: 'sk-test' });
  assert.equal(saved.saved, true);
  assert.deepEqual(saved.settings, { projected: true });
  assert.deepEqual(await api.clearCredential('deepseek'), { cleared: true, settings: { projected: true } });
});

test('credential save and clear propagate asynchronous settings failures', async () => {
  const api = commands(async () => { throw new Error('settings write failed'); });
  await assert.rejects(api.saveCredential('deepseek', { deepseekApiKey: 'sk-test' }), /settings write failed/);
  await assert.rejects(api.clearCredential('deepseek'), /settings write failed/);
});
