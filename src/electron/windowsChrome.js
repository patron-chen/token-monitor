'use strict';

// Windows-only cosmetic chrome and reveal fixes for frameless widgets — things
// macOS handles natively but Electron cannot express cleanly on win32, so we
// use documented DWM / User32 APIs through koffi:
//
//   1. DWMWA_WINDOW_CORNER_PREFERENCE = ROUND — anti-aliased OS corner mask for
//      transparent frameless windows.
//   2. DWMWA_BORDER_COLOR = NONE — hide the 1px pale hairline border DWM draws
//      around frameless windows on Windows 11.
//   3. Flash-free reveal on transparent hosts (Win10 + Win11) — Electron's
//      Win32 BaseWindow/BrowserWindow show() runs a ~200-290ms compositor fade /
//      surface-attach ramp on transparent hosts (blank acrylic slab or black/
//      dim ramp) on initial open AND every hide->show tray reopen. Cloaking the
//      HWND (DWMWA_CLOAK) across Electron's show()/showInactive() settle window
//      wakes WebContentsView in Chromium while keeping the reveal invisible
//      until the compositor has drawn a live frame.
//
// macOS / Linux: every entry point no-ops. koffi and dwmapi.dll are loaded
// lazily and guarded, so missing native APIs never break window flows.

const DWMWA_TRANSITIONS_FORCEDISABLED = 3; // dwmapi.h, Vista+
const DWMWA_CLOAK = 13; // dwmapi.h, Windows 8+ (covers Win10 & Win11)
const DWMWA_WINDOW_CORNER_PREFERENCE = 33; // dwmapi.h, Windows 11 Build 22000+
const DWMWCP_ROUND = 2;
const DWMWA_BORDER_COLOR = 34; // dwmapi.h, Windows 11 Build 22000+
const DWMWA_COLOR_NONE = 0xfffffffe;

const INITIAL_REVEAL_SETTLE_MS = 260;

// null = not yet probed, false = unavailable, object = ready
let nativeChromeApi = null;
const revealStates = new WeakMap();

function hwndOf(win)
{
  if (!win || typeof win.getNativeWindowHandle !== 'function')
  {
    return null;
  }
  const buf = win.getNativeWindowHandle(); // pointer-sized little-endian Buffer
  if (!buf || buf.length < 4)
  {
    return null;
  }
  return buf.length >= 8 ? buf.readBigUInt64LE() : BigInt(buf.readUInt32LE());
}

function loadNativeChromeApi()
{
  if (nativeChromeApi !== null)
  {
    return nativeChromeApi;
  }
  try
  {
    const koffi = require('koffi');
    const dwmapi = koffi.load('dwmapi.dll');
    const DwmSetWindowAttribute = dwmapi.func(
      'int DwmSetWindowAttribute(uintptr_t hwnd, uint dwAttribute, void *pvAttribute, uint cbAttribute)'
    );
    const setUint = (hwnd, attribute, value) =>
    {
      const buf = Buffer.alloc(4);
      buf.writeUInt32LE(value >>> 0);
      return DwmSetWindowAttribute(hwnd, attribute, buf, 4) === 0;
    };
    nativeChromeApi = {
      setUint,
      setCloak: (hwnd, cloaked) => setUint(hwnd, DWMWA_CLOAK, cloaked ? 1 : 0)
    };
  }
  catch (_)
  {
    nativeChromeApi = false;
  }
  return nativeChromeApi;
}

function resolveRevealApi(deps = {}, platform = process.platform)
{
  if (deps.api)
  {
    return deps.api;
  }
  if (platform !== 'win32')
  {
    return null;
  }
  return loadNativeChromeApi() || null;
}

function flushWaiters(state)
{
  if (!state || state.waiters.size === 0)
  {
    return;
  }
  const pending = Array.from(state.waiters);
  state.waiters.clear();
  for (const fn of pending)
  {
    try
    {
      fn();
    }
    catch (_) {}
  }
}

function focusIfFocusable(win)
{
  if (!win || win.isDestroyed?.())
  {
    return;
  }
  if (typeof win.isFocusable === 'function' && !win.isFocusable())
  {
    return;
  }
  if (typeof win.focus === 'function')
  {
    win.focus();
  }
}

function runBeforeShow(state)
{
  for (const fn of state.beforeShowHandlers)
  {
    try
    {
      fn();
    }
    catch (_) {}
  }
}

/**
 * Attaches Win32 cloaked warm-up and flash-free Electron show reveal
 * handling to a single transparent window instance without altering prototypes.
 */
function attachWindowsReveal(win, deps = {})
{
  const platform = deps.platform || process.platform;
  if (platform !== 'win32' || !win || win.isDestroyed?.())
  {
    return null;
  }
  const existing = revealStates.get(win);
  if (existing)
  {
    return existing;
  }
  const api = resolveRevealApi(deps, platform);
  if (!api)
  {
    return null;
  }
  const setTimer = deps.setTimeout || setTimeout;
  const clearTimer = deps.clearTimeout || clearTimeout;
  const settleMs = Number.isFinite(deps.settleMs) ? Math.max(0, deps.settleMs) : INITIAL_REVEAL_SETTLE_MS;
  const baseShow = typeof win.show === 'function' ? win.show.bind(win) : null;
  const baseShowInactive = typeof win.showInactive === 'function' ? win.showInactive.bind(win) : baseShow;
  const baseHide = typeof win.hide === 'function' ? win.hide.bind(win) : null;

  const state = {
    status: 'unwarmed',
    pendingHide: false,
    pendingFocus: false,
    prewarming: false,
    internalHide: false,
    settleTimer: null,
    waiters: new Set(),
    beforeShowHandlers: new Set(),
    api,
    setTimer,
    clearTimer,
    settleMs,
    baseShow,
    baseShowInactive,
    baseHide
  };

  const clearSettleTimer = () =>
  {
    if (state.settleTimer !== null)
    {
      state.clearTimer(state.settleTimer);
      state.settleTimer = null;
    }
  };

  const uncloak = () =>
  {
    const hwnd = hwndOf(win);
    if (hwnd !== null)
    {
      try
      {
        state.api.setCloak(hwnd, false);
      }
      catch (_) {}
    }
  };

  const finishWarmSettle = () =>
  {
    state.settleTimer = null;
    if (win.isDestroyed?.())
    {
      state.status = 'ready';
      state.prewarming = false;
      flushWaiters(state);
      return;
    }
    if (state.pendingHide)
    {
      // Keep DWM cloak active until baseHide completes so no frame escapes during pre-warm teardown.
      state.internalHide = true;
      try
      {
        state.baseHide?.();
      }
      finally
      {
        state.internalHide = false;
        state.prewarming = false;
        uncloak();
      }
      state.status = 'ready';
      flushWaiters(state);
      return;
    }
    state.prewarming = false;
    uncloak();
    state.status = 'ready';
    if (state.pendingFocus)
    {
      focusIfFocusable(win);
    }
    flushWaiters(state);
  };

  const startCloakedShow = ({ inactive = false, pendingHide = false } = {}) =>
  {
    const hwnd = hwndOf(win);
    if (hwnd === null || !state.baseShow)
    {
      state.status = 'ready';
      (inactive ? state.baseShowInactive : state.baseShow)?.();
      return;
    }
    state.status = 'warming';
    state.pendingHide = pendingHide;
    state.pendingFocus = !inactive && (typeof win.isFocusable !== 'function' || win.isFocusable());
    state.prewarming = pendingHide;
    try
    {
      state.api.setCloak(hwnd, true);
    }
    catch (_) {}
    if (inactive)
    {
      state.baseShowInactive?.();
    }
    else
    {
      state.baseShow();
    }
    clearSettleTimer();
    state.settleTimer = state.setTimer(finishWarmSettle, state.settleMs);
  };

  state.startWarm = () =>
  {
    if (win.isDestroyed?.() || win.isVisible?.() || state.status !== 'unwarmed')
    {
      return false;
    }
    runBeforeShow(state);
    startCloakedShow({ inactive: true, pendingHide: true });
    return true;
  };

  const reveal = (inactive) =>
  {
    if (win.isDestroyed?.())
    {
      return;
    }
    const wantFocus = !inactive && (typeof win.isFocusable !== 'function' || win.isFocusable());
    const minimized = typeof win.isMinimized === 'function' && win.isMinimized();

    if (win.isVisible?.() && !minimized)
    {
      if (state.status === 'warming')
      {
        const wasPrewarm = state.pendingHide;
        state.pendingHide = false;
        state.pendingFocus = wantFocus;
        state.prewarming = false;
        if (wasPrewarm)
        {
          // Promote a cloaked tray pre-warm into a real user reveal without losing stats or plugin visibility.
          runBeforeShow(state);
          win.emit?.('show');
        }
        return;
      }
      if (wantFocus)
      {
        focusIfFocusable(win);
      }
      return;
    }

    runBeforeShow(state);

    // Always drive hidden BaseWindow + WebContentsView reveals through Electron's
    // baseShow/baseShowInactive under DWM cloak: bypassing baseShow with raw Win32
    // ShowWindow leaves Chromium's WebContentsView hidden and renders a blank window.
    if ((state.status === 'unwarmed' || state.status === 'ready') && !minimized)
    {
      startCloakedShow({ inactive, pendingHide: false });
      return;
    }

    if (inactive && state.baseShowInactive)
    {
      state.baseShowInactive();
    }
    else
    {
      state.baseShow?.();
    }
  };

  if (typeof win.show === 'function')
  {
    win.show = () => reveal(false);
  }
  if (typeof win.showInactive === 'function')
  {
    win.showInactive = () => reveal(true);
  }

  if (typeof win.on === 'function')
  {
    win.on('hide', () =>
    {
      if (state.internalHide || state.status !== 'warming')
      {
        return;
      }
      clearSettleTimer();
      uncloak();
      state.prewarming = false;
      state.pendingHide = false;
      state.status = 'unwarmed';
      flushWaiters(state);
    });
    win.once?.('closed', () =>
    {
      clearSettleTimer();
      state.prewarming = false;
      flushWaiters(state);
      revealStates.delete(win);
    });
  }

  revealStates.set(win, state);
  return state;
}

function warmWindowsWindow(win)
{
  const state = revealStates.get(win);
  if (!state)
  {
    return false;
  }
  return state.startWarm();
}

function isWindowsWindowCloaked(win)
{
  return revealStates.get(win)?.status === 'warming';
}

function isWindowsRevealPrewarming(win)
{
  return revealStates.get(win)?.prewarming === true;
}

function whenWindowsRevealSettled(win, callback)
{
  if (typeof callback !== 'function')
  {
    return;
  }
  const state = revealStates.get(win);
  if (!state || state.status !== 'warming')
  {
    callback();
    return;
  }
  state.waiters.add(callback);
}

function onBeforeWindowsReveal(win, handler)
{
  const state = revealStates.get(win);
  if (!state || typeof handler !== 'function')
  {
    return () => {};
  }
  state.beforeShowHandlers.add(handler);
  return () => state.beforeShowHandlers.delete(handler);
}

// The collapsed floating bubble can be dragged anywhere, so it keeps the same
// anti-aliased DWM rounding as the expanded widget.
function applyWindowsChrome(win, { round = false, preventRevealFlash = false } = {})
{
  if (process.platform !== 'win32')
  {
    return;
  }
  if (!win || win.isDestroyed?.())
  {
    return;
  }
  const api = loadNativeChromeApi();
  if (!api)
  {
    return;
  }
  try
  {
    const hwnd = hwndOf(win);
    if (hwnd !== null)
    {
      if (round)
      {
        api.setUint(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND);
      }
      api.setUint(hwnd, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE);
      if (preventRevealFlash)
      {
        api.setUint(hwnd, DWMWA_TRANSITIONS_FORCEDISABLED, 1);
      }
    }
  }
  catch (_)
  {
    // Best-effort cosmetic tweak; never break window creation.
  }
  if (preventRevealFlash)
  {
    attachWindowsReveal(win, { api });
  }
}

module.exports = {
  applyWindowsChrome,
  attachWindowsReveal,
  isWindowsRevealPrewarming,
  isWindowsWindowCloaked,
  onBeforeWindowsReveal,
  warmWindowsWindow,
  whenWindowsRevealSettled
};
