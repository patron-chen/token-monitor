'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeferredMainWindowPush } = require('../../src/electron/deferredMainWindowPush');

function makeFakeClock()
{
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer(fn, delay)
    {
      const id = nextId++;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimer(id)
    {
      timers.delete(id);
    },
    runAll()
    {
      const pending = Array.from(timers.entries());
      timers.clear();
      for (const [, entry] of pending)
      {
        entry.fn();
      }
    },
    count()
    {
      return timers.size;
    }
  };
}

test('session-activity while hidden does not overwrite deferred stats snapshot', () =>
{
  const clock = makeFakeClock();
  const queue = createDeferredMainWindowPush({
    delayMs: 50,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  });
  let visible = false;
  const sent = [];

  queue.deliver({ event: 'status', data: { connected: true } }, {
    isVisible: () => visible,
    send: (payload) => sent.push(payload)
  });
  queue.deliver({ event: 'stats', data: { type: 'stats', stats: { totalTokens: 1234 } } }, {
    isVisible: () => visible,
    send: (payload) => sent.push(payload)
  });
  queue.deliver({ event: 'session-activity', data: { patch: { claude: [] } } }, {
    isVisible: () => visible,
    send: (payload) => sent.push(payload)
  });

  assert.equal(sent.length, 0);
  assert.equal(queue.hasPending(), true);

  visible = true;
  queue.flush({
    canSend: () => visible,
    send: (payload) => sent.push(payload)
  });
  clock.runAll();

  assert.deepEqual(sent.map((item) => item.event), ['status', 'stats', 'session-activity']);
  assert.equal(sent[1].data.stats.totalTokens, 1234);
  assert.equal(queue.hasPending(), false);
});

test('cancelling flush on hide retains deferred stats until the next visible reveal', () =>
{
  const clock = makeFakeClock();
  const queue = createDeferredMainWindowPush({
    delayMs: 50,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  });
  let visible = false;
  const sent = [];

  queue.deliver({ event: 'stats', data: { stats: { totalTokens: 99 } } }, {
    isVisible: () => visible,
    send: (payload) => sent.push(payload)
  });

  visible = true;
  queue.flush({
    canSend: () => visible,
    send: (payload) => sent.push(payload)
  });
  assert.equal(clock.count(), 1);

  visible = false;
  queue.cancelFlush();
  clock.runAll();
  assert.equal(sent.length, 0);
  assert.equal(queue.hasPending(), true);

  visible = true;
  queue.flush({
    canSend: () => visible,
    send: (payload) => sent.push(payload)
  });
  clock.runAll();
  assert.deepEqual(sent.map((item) => item.data.stats.totalTokens), [99]);
});

test('live full stats push after reveal cancels stale deferred stats and activity payloads', () =>
{
  const clock = makeFakeClock();
  const queue = createDeferredMainWindowPush({
    delayMs: 50,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  });
  let visible = false;
  const sent = [];

  queue.deliver({ event: 'status', data: { connected: true } }, {
    isVisible: () => visible,
    send: (payload) => sent.push(payload)
  });
  queue.deliver({ event: 'stats', data: { stats: { totalTokens: 100 } } }, {
    isVisible: () => visible,
    send: (payload) => sent.push(payload)
  });
  queue.deliver({ event: 'session-activity', data: { patch: { claude: [] } } }, {
    isVisible: () => visible,
    send: (payload) => sent.push(payload)
  });

  visible = true;
  queue.flush({
    canSend: () => visible,
    send: (payload) => sent.push(payload)
  });

  queue.deliver({ event: 'stats', data: { stats: { totalTokens: 200 } } }, {
    isVisible: () => visible,
    send: (payload) => sent.push(payload)
  });
  clock.runAll();

  assert.deepEqual(sent.map((item) => item.event), ['stats', 'status']);
  assert.equal(sent[0].data.stats.totalTokens, 200);
});

test('immediate flush delivers pending snapshots synchronously without waiting for reveal settle delay', () =>
{
  const clock = makeFakeClock();
  const queue = createDeferredMainWindowPush({
    delayMs: 50,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  });
  const sent = [];

  queue.deliver({ event: 'stats', data: { stats: { totalTokens: 42 } } }, {
    isVisible: () => false,
    send: (payload) => sent.push(payload)
  });

  queue.flush({
    immediate: true,
    canSend: () => true,
    send: (payload) => sent.push(payload)
  });

  assert.equal(clock.count(), 0);
  assert.deepEqual(sent.map((item) => item.data.stats.totalTokens), [42]);
  assert.equal(queue.hasPending(), false);
});
