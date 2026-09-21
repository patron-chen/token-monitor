'use strict';

const { createAiProxyController, normalizeProxySettings, proxySettingsChanged } = require('./aiProxy');
const { createElectronLimitsFetch } = require('./limits/fetch');
const { createClaudeWebFetch } = require('./providers/claude/webFetch');

function createProxyRuntime({ net, sessionFactory, env = process.env, logger = console.warn }) {
  let controller = null;
  const systemFetch = createElectronLimitsFetch({ net, env });

  function requestSession() {
    return controller?.requestSession() || null;
  }

  function limitsFetch(input, init = {}) {
    const targetSession = requestSession();
    return targetSession
      ? createElectronLimitsFetch({ net, session: targetSession })(input, init)
      : systemFetch(input, init);
  }

  const claudeWebFetch = createClaudeWebFetch(net, { session: requestSession });

  async function start(settings) {
    controller = createAiProxyController({ sessionFactory, net });
    try {
      await controller.apply(settings);
      return normalizeProxySettings(settings);
    } catch (_error) {
      logger('[proxy] Could not apply saved proxy settings');
      const fallback = normalizeProxySettings({});
      await controller.apply(fallback);
      return fallback;
    }
  }

  function normalizeSaved(settings, defaults) {
    try { return normalizeProxySettings(settings); }
    catch (error) {
      logger(`[proxy] Ignoring invalid saved proxy settings (${error.code || 'invalid-config'})`);
      return normalizeProxySettings(defaults);
    }
  }

  async function applySaved(settings, rollback) {
    try { await controller.apply(settings); }
    catch (error) {
      rollback();
      throw new Error('Could not apply proxy settings', { cause: error });
    }
  }

  function test(draft, settings) {
    return controller.test({
      ...settings,
      ...draft,
      proxyPassword: Object.hasOwn(draft || {}, 'proxyPassword')
        ? draft.proxyPassword
        : settings.proxyPassword
    });
  }

  function onLogin(event, authInfo, callback) {
    const credentials = controller?.activeCredentialsFor(authInfo);
    if (!credentials) return;
    event.preventDefault();
    callback(credentials.username, credentials.password);
  }

  return {
    defaults: () => normalizeProxySettings({}),
    normalizeSaved,
    normalizePatch: (current, patch) => normalizeProxySettings({ ...current, ...patch }),
    changed: proxySettingsChanged,
    start,
    applySaved,
    test,
    onLogin,
    limitsFetch,
    claudeWebFetch
  };
}

module.exports = { createProxyRuntime };
