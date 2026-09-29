'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createMemoryOptimizer } = require('../../src/electron/memoryOptimizer');

test('createMemoryOptimizer initializes without throwing', () => {
  const optimizer = createMemoryOptimizer();
  assert.ok(optimizer);
  assert.equal(typeof optimizer.trimProcess, 'function');
  assert.equal(typeof optimizer.trimAll, 'function');
  assert.equal(typeof optimizer.scheduleTrim, 'function');
  assert.equal(typeof optimizer.cancelScheduledTrim, 'function');
});

test('trimProcess handles current pid safely', () => {
  const optimizer = createMemoryOptimizer();
  const result = optimizer.trimProcess(process.pid);
  assert.equal(typeof result, 'boolean');
});

test('trimAll handles array of pids without throwing', () => {
  const optimizer = createMemoryOptimizer();
  assert.doesNotThrow(() => {
    optimizer.trimAll([process.pid, 9999999]);
  });
});

test('scheduleTrim and cancelScheduledTrim manage timers correctly', () => {
  const optimizer = createMemoryOptimizer({ minTrimIntervalMs: 0 });
  let called = false;
  optimizer.scheduleTrim(() => {
    called = true;
    return [process.pid];
  }, 10);
  optimizer.cancelScheduledTrim();
  // Wait to confirm canceled timer did not fire
  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(called, false);
      resolve();
    }, 30);
  });
});

test('scheduleTrim fires getter when timer elapses', async () => {
  const optimizer = createMemoryOptimizer({ minTrimIntervalMs: 0 });
  let getterCalled = false;
  optimizer.scheduleTrim(() => {
    getterCalled = true;
    return [process.pid];
  }, 10);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(getterCalled, true);
});
