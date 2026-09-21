'use strict';

(function exposeProxySettingsPanel(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    api.installMarkup(root.document);
    root.TokenMonitorProxySettingsPanel = api;
  }
})(typeof window !== 'undefined' ? window : null, function createApi() {
  const MARKUP = `
            <div id="proxyGroup" class="settings-group settings-subgroup proxy-settings">
              <div class="settings-group-header"><span data-i18n="settings.proxy.title">Network proxy</span></div>
              <label class="settings-field">
                <span class="settings-field-label" data-i18n="settings.proxy.mode">Connection mode</span>
                <select id="proxyModeInput">
                  <option value="system" data-i18n="settings.proxy.mode.system">Follow system</option>
                  <option value="direct" data-i18n="settings.proxy.mode.direct">Direct connection</option>
                  <option value="custom" data-i18n="settings.proxy.mode.custom">Custom proxy</option>
                </select>
              </label>
              <span class="settings-item-desc" data-i18n="settings.proxy.scope">Applies only to AI quota, account verification, and login helper requests.</span>
              <div id="proxyCustomFields" class="proxy-custom-fields hidden">
                <label class="settings-field">
                  <span class="settings-field-label" data-i18n="settings.proxy.url">Proxy URL</span>
                  <input id="proxyUrlInput" type="text" maxlength="2048" spellcheck="false" autocomplete="off" placeholder="http://127.0.0.1:7890" />
                  <span class="settings-item-desc" data-i18n="settings.proxy.urlHelp">HTTP(S), SOCKS5, and SOCKS4 are supported. Enter credentials separately.</span>
                </label>
                <label class="settings-field">
                  <span class="settings-field-label" data-i18n="settings.proxy.bypass">Bypass rules</span>
                  <textarea id="proxyBypassInput" rows="3" maxlength="8192" spellcheck="false"></textarea>
                  <span class="settings-item-desc" data-i18n="settings.proxy.bypassHelp">Separate rules with commas or new lines.</span>
                </label>
                <div id="proxyAuthFields" class="proxy-auth-fields">
                  <label class="settings-field">
                    <span class="settings-field-label" data-i18n="settings.proxy.username">Username</span>
                    <input id="proxyUsernameInput" type="text" maxlength="512" autocomplete="off" />
                  </label>
                  <label class="settings-field">
                    <span class="settings-field-label" data-i18n="settings.proxy.password">Password</span>
                    <input id="proxyPasswordInput" type="password" maxlength="2048" autocomplete="new-password" />
                    <span id="proxyPasswordConfigured" class="settings-item-desc hidden" data-i18n="settings.proxy.passwordConfigured">A saved password is configured. Leave blank to keep it.</span>
                  </label>
                </div>
                <span id="proxySocksAuthNote" class="settings-item-desc hidden" data-i18n="settings.proxy.socksAuth">SOCKS proxy authentication is not supported by Chromium. Saved HTTP credentials are preserved.</span>
              </div>
              <div class="settings-actions proxy-actions">
                <button id="proxyTestButton" type="button" data-i18n="settings.proxy.test">Test proxy</button>
                <button id="proxyApplyButton" type="button" data-i18n="settings.proxy.apply">Apply</button>
                <button id="proxyClearPasswordButton" type="button" data-i18n="settings.proxy.clearPassword">Clear saved password</button>
              </div>
              <div id="proxyStatus" class="proxy-status" role="status" aria-live="polite"></div>
            </div>
`;

  function installMarkup(document) {
    document.getElementById('startupGroup')?.insertAdjacentHTML('afterend', MARKUP);
  }

  function createProxySettingsPanel({ document, api, translate: t, getSettings, saveSettings, renderSettingsSummaries }) {
    const els = {
      proxyModeInput: document.getElementById('proxyModeInput'),
      proxyCustomFields: document.getElementById('proxyCustomFields'),
      proxyUrlInput: document.getElementById('proxyUrlInput'),
      proxyBypassInput: document.getElementById('proxyBypassInput'),
      proxyAuthFields: document.getElementById('proxyAuthFields'),
      proxyUsernameInput: document.getElementById('proxyUsernameInput'),
      proxyPasswordInput: document.getElementById('proxyPasswordInput'),
      proxyPasswordConfigured: document.getElementById('proxyPasswordConfigured'),
      proxySocksAuthNote: document.getElementById('proxySocksAuthNote'),
      proxyTestButton: document.getElementById('proxyTestButton'),
      proxyApplyButton: document.getElementById('proxyApplyButton'),
      proxyClearPasswordButton: document.getElementById('proxyClearPasswordButton'),
      proxyStatus: document.getElementById('proxyStatus'),
    };
    const DEFAULT_PROXY_BYPASS_RULES = '<local>,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,fc00::/7,fe80::/10';
    let proxyDraftDirty = false;
    let proxyBusy = false;

    function proxyDraftFromInputs() {
      const draft = {
        proxyMode: ['direct', 'custom'].includes(els.proxyModeInput?.value) ? els.proxyModeInput.value : 'system',
        proxyUrl: els.proxyUrlInput?.value || '',
        proxyBypassRules: els.proxyBypassInput?.value || DEFAULT_PROXY_BYPASS_RULES,
        proxyUsername: els.proxyUsernameInput?.value || ''
      };
      if (els.proxyPasswordInput?.value) draft.proxyPassword = els.proxyPasswordInput.value;
      return draft;
    }

    function proxyDraftUsesSocks() {
      return /^socks(?:4|5)?:\/\//i.test(String(els.proxyUrlInput?.value || '').trim());
    }

    function syncProxyDraftUi({ force = false } = {}) {
      if (!els.proxyModeInput) return;
      if (force || !proxyDraftDirty) {
        els.proxyModeInput.value = ['direct', 'custom'].includes(getSettings()?.proxyMode)
          ? getSettings().proxyMode
          : 'system';
        els.proxyUrlInput.value = getSettings()?.proxyUrl || '';
        els.proxyBypassInput.value = getSettings()?.proxyBypassRules || DEFAULT_PROXY_BYPASS_RULES;
        els.proxyUsernameInput.value = getSettings()?.proxyUsername || '';
        els.proxyPasswordInput.value = '';
      }
      const custom = els.proxyModeInput.value === 'custom';
      const socks = custom && proxyDraftUsesSocks();
      els.proxyCustomFields?.classList.toggle('hidden', !custom);
      els.proxyAuthFields?.classList.toggle('is-disabled', socks);
      els.proxyUsernameInput.disabled = socks;
      els.proxyPasswordInput.disabled = socks;
      els.proxySocksAuthNote?.classList.toggle('hidden', !socks);
      const passwordConfigured = Boolean(getSettings()?.proxyPasswordConfigured);
      els.proxyPasswordConfigured?.classList.toggle('hidden', !passwordConfigured || socks);
      els.proxyClearPasswordButton?.classList.toggle('hidden', !passwordConfigured);
      els.proxyApplyButton.disabled = proxyBusy || !proxyDraftDirty;
      els.proxyTestButton.disabled = proxyBusy;
      els.proxyClearPasswordButton.disabled = proxyBusy;
    }

    function setProxyStatus(code = '', error = false) {
      if (!els.proxyStatus) return;
      const known = new Set([
        'testing', 'applying', 'applied', 'password-cleared', 'success', 'bypassed',
        'invalid-config', 'invalid-url', 'unsupported-scheme', 'embedded-credentials',
        'invalid-bypass', 'timeout', 'authentication-failed', 'connection-failed', 'http-error'
      ]);
      const normalized = known.has(code) ? code : 'invalid-config';
      els.proxyStatus.textContent = code ? t(`settings.proxy.status.${normalized}`) : '';
      els.proxyStatus.classList.toggle('is-error', Boolean(code && error));
      els.proxyStatus.classList.toggle('is-success', Boolean(code && !error));
    }

    function markProxyDraftDirty() {
      proxyDraftDirty = true;
      setProxyStatus('');
      syncProxyDraftUi();
      renderSettingsSummaries();
    }

    async function testProxyDraft() {
      proxyBusy = true;
      setProxyStatus('testing');
      syncProxyDraftUi();
      try {
        const result = await api.testProxy(proxyDraftFromInputs());
        setProxyStatus(result?.code || 'connection-failed', !result?.ok);
      } catch (_) {
        setProxyStatus('connection-failed', true);
      } finally {
        proxyBusy = false;
        syncProxyDraftUi();
      }
    }

    async function applyProxyDraft() {
      proxyBusy = true;
      setProxyStatus('applying');
      syncProxyDraftUi();
      try {
        await saveSettings(proxyDraftFromInputs());
        proxyDraftDirty = false;
        syncProxyDraftUi({ force: true });
        setProxyStatus('applied');
      } catch (_) {
        setProxyStatus('invalid-config', true);
      } finally {
        proxyBusy = false;
        syncProxyDraftUi();
      }
    }

    async function clearProxyPassword() {
      proxyBusy = true;
      syncProxyDraftUi();
      try {
        await saveSettings({ proxyPassword: '' });
        if (els.proxyPasswordInput) els.proxyPasswordInput.value = '';
        setProxyStatus('password-cleared');
      } catch (_) {
        setProxyStatus('invalid-config', true);
      } finally {
        proxyBusy = false;
        syncProxyDraftUi();
      }
    }

    els.proxyModeInput?.addEventListener('change', markProxyDraftDirty);
    els.proxyUrlInput?.addEventListener('input', markProxyDraftDirty);
    els.proxyBypassInput?.addEventListener('input', markProxyDraftDirty);
    els.proxyUsernameInput?.addEventListener('input', markProxyDraftDirty);
    els.proxyPasswordInput?.addEventListener('input', markProxyDraftDirty);
    els.proxyTestButton?.addEventListener('click', () => testProxyDraft());
    els.proxyApplyButton?.addEventListener('click', () => applyProxyDraft());
    els.proxyClearPasswordButton?.addEventListener('click', () => clearProxyPassword());
    return { syncProxyDraftUi };
  }
  return { createProxySettingsPanel, installMarkup };
});
