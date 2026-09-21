'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  DEFAULT_PROXY_BYPASS_RULES,
  createAiProxyController,
  electronProxyConfig,
  normalizeProxyBypassRules,
  normalizeProxySettings,
  normalizeProxyUrl,
  proxyAuthMatches
} = require('../../src/electron/aiProxy');

test('proxy settings normalize supported schemes and reject embedded credentials or URL paths', () => {
  assert.equal(normalizeProxyUrl(' socks://localhost:1080 '), 'socks5://localhost:1080');
  assert.equal(normalizeProxyUrl('socks4://127.0.0.1'), 'socks4://127.0.0.1');
  assert.equal(normalizeProxyUrl('https://proxy.example'), 'https://proxy.example');
  assert.throws(() => normalizeProxySettings({ proxyMode: 'unsupported' }), { code: 'invalid-mode' });
  assert.throws(() => normalizeProxyUrl('ftp://proxy.example'), { code: 'unsupported-scheme' });
  assert.throws(() => normalizeProxyUrl('http://user:pass@proxy.example'), { code: 'embedded-credentials' });
  assert.throws(() => normalizeProxyUrl('http://proxy.example/path'), { code: 'invalid-url' });
  assert.throws(() => normalizeProxySettings({ proxyMode: 'custom' }), { code: 'invalid-url' });
});

test('proxy bypass rules accept comma, semicolon, and line separators with stable defaults', () => {
  assert.equal(normalizeProxyBypassRules('localhost; 10.0.0.0/8\nlocalhost'), 'localhost,10.0.0.0/8');
  assert.equal(normalizeProxySettings({}).proxyBypassRules, DEFAULT_PROXY_BYPASS_RULES);
  assert.throws(() => normalizeProxyBypassRules('bad rule'), { code: 'invalid-bypass' });
});

test('Electron proxy config distinguishes system, direct, and fixed server modes', () => {
  assert.deepEqual(electronProxyConfig({ proxyMode: 'system' }), { mode: 'system' });
  assert.deepEqual(electronProxyConfig({ proxyMode: 'direct' }), { mode: 'direct' });
  assert.deepEqual(electronProxyConfig({
    proxyMode: 'custom',
    proxyUrl: 'http://127.0.0.1:7890',
    proxyBypassRules: '<local>\n10.0.0.0/8'
  }), {
    mode: 'fixed_servers',
    proxyRules: 'http://127.0.0.1:7890',
    proxyBypassRules: '<local>,10.0.0.0/8'
  });
});

test('proxy authentication is restricted to matching HTTP(S) proxy challenges', () => {
  const settings = { proxyMode: 'custom', proxyUrl: 'https://Proxy.Example:8443' };
  assert.equal(proxyAuthMatches({ isProxy: true, host: 'proxy.example', port: 8443 }, settings), true);
  assert.equal(proxyAuthMatches({ isProxy: false, host: 'proxy.example', port: 8443 }, settings), false);
  assert.equal(proxyAuthMatches({ isProxy: true, host: 'other.example', port: 8443 }, settings), false);
  assert.equal(proxyAuthMatches(
    { isProxy: true, host: 'proxy.example', port: 8443 },
    { ...settings, proxyMode: 'direct' }
  ), false);
  assert.equal(proxyAuthMatches(
    { isProxy: true, host: 'proxy.example', port: 1080 },
    { proxyMode: 'custom', proxyUrl: 'socks5://proxy.example:1080' }
  ), false);
});

test('controller applies isolated proxy sessions, closes pools, and uses no-store fetches', async () => {
  const sessions = new Map();
  const sessionFactory = (name) => {
    const record = {
      configs: [],
      closed: 0,
      fetches: [],
      async setProxy(config) { this.configs.push(config); },
      async closeAllConnections() { this.closed += 1; },
      async fetch(input, init) { this.fetches.push({ input, init }); return { ok: true }; }
    };
    sessions.set(name, record);
    return record;
  };
  const controller = createAiProxyController({ sessionFactory, net: { request() {} } });
  await controller.apply({ proxyMode: 'direct' });
  await controller.fetch('https://provider.test', { headers: { accept: 'application/json' } });
  const active = sessions.get('token-monitor-ai-proxy');
  assert.deepEqual(active.configs, [{ mode: 'direct' }]);
  assert.equal(active.closed, 1);
  assert.equal(active.fetches[0].init.credentials, 'omit');
  assert.equal(active.fetches[0].init.cache, 'no-store');
});

test('failed proxy changes restore the last effective session configuration', async () => {
  const configs = [];
  let rejectNext = false;
  const targetSession = {
    async setProxy(config) {
      configs.push(config);
      if (rejectNext) {
        rejectNext = false;
        throw new Error('proxy rejected');
      }
    },
    async closeAllConnections() {}
  };
  const controller = createAiProxyController({
    sessionFactory: () => targetSession,
    net: { request() {} }
  });
  await controller.apply({ proxyMode: 'direct' });
  rejectNext = true;
  await assert.rejects(
    () => controller.apply({ proxyMode: 'custom', proxyUrl: 'http://proxy.test:8080' }),
    /proxy rejected/
  );
  assert.deepEqual(configs.at(-1), { mode: 'direct' });
  assert.equal(controller.requestSession(), targetSession);
});

test('proxy test uses a separate session and reports a bypassed successful request', async () => {
  const sessions = new Map();
  const sessionFactory = (name) => {
    const record = {
      async setProxy() {},
      async closeAllConnections() {},
      async resolveProxy() { return 'DIRECT'; }
    };
    sessions.set(name, record);
    return record;
  };
  const net = {
    request(options) {
      const request = new EventEmitter();
      request.end = () => {
        const response = new EventEmitter();
        response.statusCode = 204;
        request.emit('response', response);
        queueMicrotask(() => response.emit('end'));
      };
      request.abort = () => {};
      request.options = options;
      return request;
    }
  };
  const controller = createAiProxyController({ sessionFactory, net });
  const result = await controller.test({ proxyMode: 'custom', proxyUrl: 'http://proxy.test:8080' });
  assert.equal(result.ok, true);
  assert.equal(result.code, 'bypassed');
  assert.equal(JSON.stringify(result).includes('proxy.test'), false);
  assert.equal(sessions.has('token-monitor-proxy-test'), true);
  assert.equal(sessions.has('token-monitor-ai-proxy'), false);
});
