'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  attachWindowsReveal,
  isWindowsRevealPrewarming,
  isWindowsWindowCloaked,
  onBeforeWindowsReveal,
  warmWindowsWindow,
  whenWindowsRevealSettled
} = require('../../src/electron/windowsChrome');
const { handoffWindow } = require('../../src/electron/windowLifecycle');

function fakeTimers()
{
  const timers = [];
  return {
    timers,
    setTimeout(fn, ms)
    {
      const handle = { fn, ms, cleared: false };
      timers.push(handle);
      return handle;
    },
    clearTimeout(handle)
    {
      if (handle) handle.cleared = true;
    },
    flushNext()
    {
      const next = timers.find((entry) => !entry.cleared);
      if (!next) return false;
      next.cleared = true;
      next.fn();
      return true;
    }
  };
}

function fakeApi(calls)
{
  return {
    setCloak(hwnd, cloaked)
    {
      calls.push(['cloak', hwnd, cloaked]);
      return true;
    },
    showNative(hwnd, inactive)
    {
      calls.push(['showNative', hwnd, inactive]);
      return true;
    }
  };
}

class FakeNativeWindow extends EventEmitter
{
  constructor({ hwnd = 0x1234n, focusable = true } = {})
  {
    super();
    this.hwnd = hwnd;
    this.focusable = focusable;
    this.visible = false;
    this.minimized = false;
    this.calls = [];
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(hwnd);
    this.nativeHandle = buf;
  }

  getNativeWindowHandle() { return this.nativeHandle; }
  isDestroyed() { return this.destroyed === true; }
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  isFocusable() { return this.focusable; }
  show() { this.calls.push('baseShow'); this.visible = true; this.emit('show'); }
  showInactive() { this.calls.push('baseShowInactive'); this.visible = true; this.emit('show'); }
  hide() { this.calls.push('hide'); this.visible = false; this.emit('hide'); }
  focus() { this.calls.push('focus'); }
  destroy() { this.destroyed = true; this.emit('closed'); }
}

test('cloaked first reveal uncloaks after settling and subsequent opens use native ShowWindow without Electron show()', () =>
{
  const win = new FakeNativeWindow();
  const apiCalls = [];
  const clock = fakeTimers();
  let beforeShowCount = 0;

  attachWindowsReveal(win, {
    platform: 'win32',
    api: fakeApi(apiCalls),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    settleMs: 260
  });
  onBeforeWindowsReveal(win, () => { beforeShowCount += 1; });

  win.show();
  assert.equal(beforeShowCount, 1);
  assert.equal(isWindowsWindowCloaked(win), true);
  assert.deepEqual(win.calls, ['baseShow']);
  assert.deepEqual(apiCalls, [['cloak', 0x1234n, true]]);

  assert.equal(clock.flushNext(), true);
  assert.equal(isWindowsWindowCloaked(win), false);
  assert.deepEqual(apiCalls, [['cloak', 0x1234n, true], ['cloak', 0x1234n, false]]);
  assert.deepEqual(win.calls, ['baseShow', 'focus']);

  // Calling show() when already visible focuses without calling native baseShow().
  win.show();
  assert.deepEqual(win.calls, ['baseShow', 'focus', 'focus']);

  // Hide and reopen from tray: must use native ShowWindow(SW_SHOW), emit 'show', focus, and never call baseShow().
  let showEvents = 0;
  win.on('show', () => { showEvents += 1; });
  win.hide();
  win.show();
  assert.equal(beforeShowCount, 2);
  assert.equal(showEvents, 1);
  assert.deepEqual(apiCalls.slice(-1), [['showNative', 0x1234n, false]]);
  assert.deepEqual(win.calls, ['baseShow', 'focus', 'focus', 'hide', 'focus']);
});

test('silent tray pre-warm uses cloaked showInactive, hides before uncloaking, and opens via ShowWindow on click', () =>
{
  const win = new FakeNativeWindow();
  const apiCalls = [];
  const clock = fakeTimers();

  attachWindowsReveal(win, {
    platform: 'win32',
    api: fakeApi(apiCalls),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    settleMs: 260
  });

  let sawPrewarmFlag = null;
  win.on('show', () =>
  {
    if (sawPrewarmFlag === null) sawPrewarmFlag = isWindowsRevealPrewarming(win);
  });

  assert.equal(warmWindowsWindow(win), true);
  assert.equal(sawPrewarmFlag, true);
  assert.equal(isWindowsRevealPrewarming(win), true);
  assert.equal(win.isVisible(), true);
  assert.deepEqual(win.calls, ['baseShowInactive']);

  // Settle hides BEFORE uncloaking so zero blank frame is ever exposed.
  clock.flushNext();
  assert.equal(isWindowsRevealPrewarming(win), false);
  assert.equal(win.isVisible(), false);
  assert.deepEqual(apiCalls, [['cloak', 0x1234n, true], ['cloak', 0x1234n, false]]);
  assert.deepEqual(win.calls, ['baseShowInactive', 'hide']);

  win.show();
  assert.deepEqual(apiCalls.slice(-1), [['showNative', 0x1234n, false]]);
  assert.deepEqual(win.calls, ['baseShowInactive', 'hide', 'focus']);
});

test('a tray click during silent pre-warm cancels the auto-hide and promotes cleanly on uncloak', () =>
{
  const win = new FakeNativeWindow();
  const apiCalls = [];
  const clock = fakeTimers();

  attachWindowsReveal(win, {
    platform: 'win32',
    api: fakeApi(apiCalls),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    settleMs: 260
  });

  warmWindowsWindow(win);
  let realShows = 0;
  win.on('show', () =>
  {
    if (!isWindowsRevealPrewarming(win)) realShows += 1;
  });

  win.show();
  assert.equal(isWindowsRevealPrewarming(win), false);
  assert.equal(realShows, 1);

  clock.flushNext();
  assert.equal(win.isVisible(), true);
  assert.deepEqual(win.calls, ['baseShowInactive', 'focus']);
  assert.deepEqual(apiCalls, [['cloak', 0x1234n, true], ['cloak', 0x1234n, false]]);
});

test('handoffWindow waits for cloaked replacement settle before destroying old host, while non-cloaked settles synchronously', () =>
{
  const oldWin = new FakeNativeWindow({ hwnd: 0x100n });
  oldWin.visible = true;
  const nextWin = new FakeNativeWindow({ hwnd: 0x200n });
  const apiCalls = [];
  const clock = fakeTimers();

  attachWindowsReveal(nextWin, {
    platform: 'win32',
    api: fakeApi(apiCalls),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    settleMs: 260
  });

  nextWin.show();
  handoffWindow(oldWin, nextWin, { focus: true, setTimeout: () => 0, clearTimeout() {} });
  assert.equal(oldWin.isDestroyed(), false, 'old host stays visible while replacement is cloaked');

  let settled = false;
  whenWindowsRevealSettled(nextWin, () => { settled = true; });
  assert.equal(settled, false);

  clock.flushNext();
  assert.equal(settled, true);
  assert.equal(oldWin.isDestroyed(), true);
});
