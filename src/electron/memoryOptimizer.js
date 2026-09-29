'use strict';

const isWindows = process.platform === 'win32';

function createMemoryOptimizer(options = {}) {
  const logger = options.logger || console;
  let trimFn = null;

  if (isWindows) {
    try {
      const koffi = require('koffi');
      const kernel32 = koffi.load('kernel32.dll');
      const psapi = koffi.load('psapi.dll');

      const GetCurrentProcess = kernel32.func('void* GetCurrentProcess()');
      const OpenProcess = kernel32.func('void* OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)');
      const CloseHandle = kernel32.func('bool CloseHandle(void* hObject)');
      const EmptyWorkingSet = psapi.func('bool EmptyWorkingSet(void* hProcess)');

      const PROCESS_SET_QUOTA = 0x0100;
      const PROCESS_QUERY_INFORMATION = 0x0400;

      trimFn = function trimProcessWorkingSet(pid) {
        if (!pid || pid === process.pid) {
          try {
            return Boolean(EmptyWorkingSet(GetCurrentProcess()));
          } catch (_) {
            return false;
          }
        }
        let handle = null;
        try {
          handle = OpenProcess(PROCESS_SET_QUOTA | PROCESS_QUERY_INFORMATION, false, pid);
          if (!handle) return false;
          return Boolean(EmptyWorkingSet(handle));
        } catch (_) {
          return false;
        } finally {
          if (handle) {
            try { CloseHandle(handle); } catch (_) {}
          }
        }
      };
    } catch (err) {
      logger.warn(`[memoryOptimizer] Win32 working set trim unavailable: ${err?.message || err}`);
    }
  }

  let trimTimer = null;
  let lastTrimAt = 0;
  const MIN_TRIM_INTERVAL_MS = options.minTrimIntervalMs ?? 15000;

  function trimProcess(pid) {
    if (typeof trimFn === 'function') {
      return trimFn(pid);
    }
    return false;
  }

  function trimAll(pids = []) {
    lastTrimAt = Date.now();
    try {
      if (typeof global.gc === 'function') {
        global.gc();
      }
    } catch (_) {}

    trimProcess(process.pid);
    const uniquePids = new Set(pids.filter((pid) => typeof pid === 'number' && pid > 0 && pid !== process.pid));
    for (const pid of uniquePids) {
      trimProcess(pid);
    }
  }

  function scheduleTrim(getPids, delayMs = 3000) {
    if (trimTimer) clearTimeout(trimTimer);
    const elapsed = Date.now() - lastTrimAt;
    const remainingCooldown = Math.max(0, MIN_TRIM_INTERVAL_MS - elapsed);
    const wait = Math.max(delayMs, remainingCooldown);
    trimTimer = setTimeout(() => {
      trimTimer = null;
      const pids = typeof getPids === 'function' ? getPids() : (Array.isArray(getPids) ? getPids : []);
      trimAll(pids);
    }, wait);
    trimTimer.unref?.();
  }

  function cancelScheduledTrim() {
    if (trimTimer) {
      clearTimeout(trimTimer);
      trimTimer = null;
    }
  }

  return {
    trimProcess,
    trimAll,
    scheduleTrim,
    cancelScheduledTrim
  };
}

module.exports = {
  createMemoryOptimizer
};
