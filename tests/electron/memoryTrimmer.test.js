'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMemoryTrimmer } = require('../../src/electron/memoryTrimmer');

test('memoryTrimmer safe no-op on non-windows platform', () => {
  let logged = false;
  const trimmer = createMemoryTrimmer({
    platform: 'darwin',
    logger: () => { logged = true; }
  });

  assert.equal(trimmer.trimCurrentProcess(), false);
  assert.equal(trimmer.trimProcessById(1234), false);
  trimmer.trimAllProcesses();
  trimmer.scheduleTrim(10);
  trimmer.startPeriodicTrim({ intervalMs: 100 });
  trimmer.destroy();
  assert.equal(logged, false);
});

test('memoryTrimmer calls win32 SetProcessWorkingSetSize via koffi mock', () => {
  const calls = [];
  const fakeKernel32 = {
    func(decl) {
      if (decl.includes('GetCurrentProcess')) {
        return () => {
          calls.push('GetCurrentProcess');
          return 999;
        };
      }
      if (decl.includes('OpenProcess')) {
        return (_access, _inherit, pid) => {
          calls.push(`OpenProcess:${pid}`);
          return pid === 404 ? 0 : 888;
        };
      }
      if (decl.includes('SetProcessWorkingSetSize')) {
        return (handle, min, max) => {
          calls.push(`SetProcessWorkingSetSize:${handle}:${min}:${max}`);
          return 1;
        };
      }
      if (decl.includes('CloseHandle')) {
        return (handle) => {
          calls.push(`CloseHandle:${handle}`);
          return 1;
        };
      }
      throw new Error(`Unexpected func: ${decl}`);
    }
  };

  const fakeKoffi = {
    load: (lib) => {
      assert.equal(lib, 'kernel32.dll');
      return fakeKernel32;
    }
  };

  const fakeApp = {
    getAppMetrics: () => [
      { pid: process.pid, type: 'Browser' },
      { pid: 1001, type: 'Renderer' },
      { pid: 1002, type: 'GPU' }
    ]
  };

  const trimmer = createMemoryTrimmer({
    platform: 'win32',
    koffiModule: fakeKoffi,
    app: fakeApp
  });

  assert.equal(trimmer.trimCurrentProcess(), true);
  assert.ok(calls.includes('GetCurrentProcess'));
  assert.ok(calls.includes('SetProcessWorkingSetSize:999:-1:-1'));

  calls.length = 0;
  trimmer.trimAllProcesses();
  assert.ok(calls.includes('GetCurrentProcess'));
  assert.ok(calls.includes('SetProcessWorkingSetSize:999:-1:-1'));
  assert.ok(calls.includes('OpenProcess:1001'));
  assert.ok(calls.includes('SetProcessWorkingSetSize:888:-1:-1'));
  assert.ok(calls.includes('CloseHandle:888'));
  assert.ok(calls.includes('OpenProcess:1002'));
});

test('memoryTrimmer scheduleTrim debounces rapid calls', async () => {
  let callCount = 0;
  const fakeKernel32 = {
    func(decl) {
      if (decl.includes('GetCurrentProcess')) return () => 999;
      if (decl.includes('SetProcessWorkingSetSize')) {
        return () => {
          callCount += 1;
          return 1;
        };
      }
      return () => 1;
    }
  };
  const fakeKoffi = { load: () => fakeKernel32 };

  const trimmer = createMemoryTrimmer({
    platform: 'win32',
    koffiModule: fakeKoffi
  });

  trimmer.scheduleTrim(20);
  trimmer.scheduleTrim(20);
  trimmer.scheduleTrim(20);

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(callCount, 1);
  trimmer.destroy();
});
