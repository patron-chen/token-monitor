'use strict';

const DEFAULT_PROXY_BYPASS_RULES = [
  '<local>',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  'fc00::/7',
  'fe80::/10'
].join(',');
const PROXY_TEST_URL = 'https://www.gstatic.com/generate_204';
const PROXY_TEST_TIMEOUT_MS = 10_000;
const PROXY_SCHEMES = new Set(['http:', 'https:', 'socks:', 'socks4:', 'socks5:']);

function proxyError(code, message) {
  return Object.assign(new Error(message), { code });
}

function normalizeProxyMode(value) {
  const mode = String(value || '').trim();
  if (!mode || mode === 'system') return 'system';
  if (mode === 'direct' || mode === 'custom') return mode;
  throw proxyError('invalid-mode', 'Proxy mode is invalid');
}

function normalizeProxyUrl(value, { required = false } = {}) {
  const raw = String(value || '').trim();
  if (!raw) {
    if (required) throw proxyError('invalid-url', 'Proxy URL is required');
    return '';
  }
  if (raw.length > 2048) throw proxyError('invalid-url', 'Proxy URL is too long');
  let parsed;
  try { parsed = new URL(raw); }
  catch (_) { throw proxyError('invalid-url', 'Proxy URL is invalid'); }
  if (!PROXY_SCHEMES.has(parsed.protocol)) {
    throw proxyError('unsupported-scheme', 'Proxy protocol must be HTTP, HTTPS, SOCKS4, or SOCKS5');
  }
  if (!parsed.hostname) throw proxyError('invalid-url', 'Proxy host is required');
  if (parsed.username || parsed.password) {
    throw proxyError('embedded-credentials', 'Enter proxy credentials in the separate username and password fields');
  }
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw proxyError('invalid-url', 'Proxy URL cannot contain a path, query, or fragment');
  }
  const protocol = parsed.protocol === 'socks:' ? 'socks5:' : parsed.protocol;
  return `${protocol}//${parsed.host}`;
}

function normalizeProxyBypassRules(value, fallback = DEFAULT_PROXY_BYPASS_RULES) {
  const raw = value === undefined || value === null ? fallback : String(value);
  if (raw.length > 8192) throw proxyError('invalid-bypass', 'Proxy bypass list is too long');
  const rules = raw
    .split(/[,;\r\n]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (rules.length > 256 || rules.some((entry) => entry.length > 512 || /\s/.test(entry))) {
    throw proxyError('invalid-bypass', 'Proxy bypass list contains an invalid rule');
  }
  return [...new Set(rules)].join(',');
}

function normalizeProxyUsername(value) {
  const username = String(value || '').trim();
  if (username.length > 512) throw proxyError('invalid-username', 'Proxy username is too long');
  return username;
}

function normalizeProxyPassword(value) {
  const password = String(value || '');
  if (password.length > 2048) throw proxyError('invalid-password', 'Proxy password is too long');
  return password;
}

function normalizeProxySettings(settings = {}) {
  const proxyMode = normalizeProxyMode(settings.proxyMode);
  const proxyUrl = normalizeProxyUrl(settings.proxyUrl, { required: proxyMode === 'custom' });
  return {
    proxyMode,
    proxyUrl,
    proxyBypassRules: normalizeProxyBypassRules(settings.proxyBypassRules),
    proxyUsername: normalizeProxyUsername(settings.proxyUsername),
    proxyPassword: normalizeProxyPassword(settings.proxyPassword)
  };
}

function proxyUrlParts(settings = {}) {
  const normalized = normalizeProxySettings(settings);
  if (!normalized.proxyUrl) return null;
  const parsed = new URL(normalized.proxyUrl);
  const defaultPort = parsed.protocol === 'http:'
    ? 80
    : parsed.protocol === 'https:'
      ? 443
      : 1080;
  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ''),
    port: Number(parsed.port) || defaultPort
  };
}

function proxySupportsAuthentication(settings = {}) {
  const protocol = proxyUrlParts(settings)?.protocol;
  return protocol === 'http:' || protocol === 'https:';
}

function electronProxyConfig(settings = {}) {
  const normalized = normalizeProxySettings(settings);
  if (normalized.proxyMode === 'direct') return { mode: 'direct' };
  if (normalized.proxyMode === 'system') return { mode: 'system' };
  return {
    mode: 'fixed_servers',
    proxyRules: normalized.proxyUrl,
    proxyBypassRules: normalized.proxyBypassRules
  };
}

function proxyAuthMatches(authInfo, settings = {}) {
  const normalized = normalizeProxySettings(settings);
  if (normalized.proxyMode !== 'custom' || !authInfo?.isProxy || !proxySupportsAuthentication(normalized)) return false;
  const endpoint = proxyUrlParts(normalized);
  return Boolean(endpoint)
    && String(authInfo.host || '').trim().toLowerCase().replace(/^\[|\]$/g, '') === endpoint.hostname
    && Number(authInfo.port) === endpoint.port;
}

function proxySettingsChanged(previous = {}, next = {}) {
  return ['proxyMode', 'proxyUrl', 'proxyBypassRules', 'proxyUsername', 'proxyPassword']
    .some((key) => String(previous?.[key] ?? '') !== String(next?.[key] ?? ''));
}

function requestErrorCode(error) {
  const text = `${error?.code || ''} ${error?.message || ''}`.toLowerCase();
  if (text.includes('timed out') || text.includes('timeout') || error?.name === 'AbortError') return 'timeout';
  if (text.includes('auth') || text.includes('407')) return 'authentication-failed';
  return 'connection-failed';
}

function createAiProxyController({ sessionFactory, net, testUrl = PROXY_TEST_URL } = {}) {
  if (typeof sessionFactory !== 'function') throw new TypeError('sessionFactory is required');
  if (!net || typeof net.request !== 'function') throw new TypeError('net.request is required');
  let activeSession = null;
  let testSession = null;
  let activeSettings = normalizeProxySettings({});

  function sessionFor(kind) {
    if (kind === 'test') {
      testSession ||= sessionFactory('token-monitor-proxy-test', { cache: false });
      return testSession;
    }
    activeSession ||= sessionFactory('token-monitor-ai-proxy', { cache: false });
    return activeSession;
  }

  async function configureSession(targetSession, settings) {
    await targetSession.setProxy(electronProxyConfig(settings));
    await targetSession.closeAllConnections?.();
    return targetSession;
  }

  async function apply(settings) {
    const normalized = normalizeProxySettings(settings);
    const previous = activeSettings;
    try {
      if (normalized.proxyMode !== 'system') {
        await configureSession(sessionFor('active'), normalized);
      } else if (activeSession) {
        await configureSession(activeSession, normalized);
      }
    } catch (error) {
      if (activeSession) {
        try { await configureSession(activeSession, previous); } catch (_) {}
      }
      throw error;
    }
    activeSettings = normalized;
    return { ...activeSettings };
  }

  function requestSession() {
    return activeSettings.proxyMode === 'system' ? null : sessionFor('active');
  }

  async function fetchWithProxy(input, init = {}) {
    const targetSession = requestSession();
    if (!targetSession) throw proxyError('system-mode', 'System mode uses the existing Electron transport');
    return targetSession.fetch(input, { ...init, credentials: 'omit', cache: 'no-store' });
  }

  function activeCredentialsFor(authInfo) {
    if (!proxyAuthMatches(authInfo, activeSettings)) return null;
    if (!activeSettings.proxyUsername && !activeSettings.proxyPassword) return null;
    return { username: activeSettings.proxyUsername, password: activeSettings.proxyPassword };
  }

  async function test(settings) {
    let normalized;
    try { normalized = normalizeProxySettings(settings); }
    catch (error) { return { ok: false, code: error.code || 'invalid-config' }; }
    try {
      const targetSession = await configureSession(sessionFor('test'), normalized);
      const route = typeof targetSession.resolveProxy === 'function'
        ? await targetSession.resolveProxy(testUrl)
        : '';
      const bypassed = normalized.proxyMode === 'custom' && /(?:^|;)DIRECT(?:;|$)/i.test(String(route));
      return await new Promise((resolve) => {
        let settled = false;
        let request;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ ...result, bypassed });
        };
        const timer = setTimeout(() => {
          try { request?.abort?.(); } catch (_) {}
          finish({ ok: false, code: 'timeout' });
        }, PROXY_TEST_TIMEOUT_MS);
        try {
          request = net.request({
            method: 'GET',
            url: testUrl,
            session: targetSession,
            credentials: 'omit',
            cache: 'no-store'
          });
          request.on('login', (authInfo, callback) => {
            if (!proxyAuthMatches(authInfo, normalized) || (!normalized.proxyUsername && !normalized.proxyPassword)) {
              callback();
              return;
            }
            callback(normalized.proxyUsername, normalized.proxyPassword);
          });
          request.on('response', (response) => {
            response.on('data', () => {});
            response.on('error', (error) => finish({ ok: false, code: requestErrorCode(error) }));
            response.on('end', () => finish({
              ok: Number(response.statusCode) >= 200 && Number(response.statusCode) < 400,
              code: Number(response.statusCode) >= 200 && Number(response.statusCode) < 400
                ? (bypassed ? 'bypassed' : 'success')
                : Number(response.statusCode) === 407 ? 'authentication-failed' : 'http-error',
              status: Number(response.statusCode) || 0
            }));
          });
          request.on('error', (error) => finish({ ok: false, code: requestErrorCode(error) }));
          request.end();
        } catch (error) {
          finish({ ok: false, code: requestErrorCode(error) });
        }
      });
    } catch (error) {
      return { ok: false, code: error.code || requestErrorCode(error) };
    }
  }

  return {
    activeCredentialsFor,
    apply,
    fetch: fetchWithProxy,
    requestSession,
    test
  };
}

module.exports = {
  DEFAULT_PROXY_BYPASS_RULES,
  PROXY_TEST_TIMEOUT_MS,
  PROXY_TEST_URL,
  createAiProxyController,
  electronProxyConfig,
  normalizeProxyBypassRules,
  normalizeProxyMode,
  normalizeProxyPassword,
  normalizeProxySettings,
  normalizeProxyUrl,
  normalizeProxyUsername,
  proxyAuthMatches,
  proxySettingsChanged,
  proxySupportsAuthentication,
  proxyUrlParts
};
