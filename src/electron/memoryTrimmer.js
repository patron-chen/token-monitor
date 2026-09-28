'use strict';

const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_QUERY_INFORMATION = 0x0400;

let win32Api = null;

function buildWin32Api(koffi) {
  try {
    const kernel32 = koffi.load('kernel32.dll');
    return {
      GetCurrentProcess: kernel32.func('void* GetCurrentProcess()'),
      OpenProcess: kernel32.func('void* OpenProcess(uint32 dwDesiredAccess, int bInheritHandle, uint32 dwProcessId)'),
      SetProcessWorkingSetSize: kernel32.func(
        'int SetProcessWorkingSetSize(void* hProcess, size_t dwMinimumWorkingSetSize, size_t dwMaximumWorkingSetSize)'
      ),
      CloseHandle: kernel32.func('int CloseHandle(void* hObject)')
    };
  } catch (_err) {
    return false;
  }
}

function loadWin32Api(koffiModule) {
  if (koffiModule) return buildWin32Api(koffiModule);
  if (win32Api !== null) return win32Api;
  if (process.platform !== 'win32') {
    win32Api = false;
    return win32Api;
  }
  try {
    const koffi = require('koffi');
    win32Api = buildWin32Api(koffi);
  } catch (_err) {
    win32Api = false;
  }
  return win32Api;
}

function createMemoryTrimmer(deps = {}) {
  const {
    app,
    platform = process.platform,
    koffiModule,
    logger = () => {}
  } = deps;

  const isWindows = platform === 'win32';
  let trimTimer = null;
  let periodicTimer = null;
  let instanceApi = null;

  function getApi() {
    if (!isWindows) return null;
    if (koffiModule) {
      if (!instanceApi) instanceApi = loadWin32Api(koffiModule);
      return instanceApi;
    }
    return loadWin32Api();
  }

  function trimCurrentProcess() {
    const api = getApi();
    if (!api) return false;
    try {
      const hProcess = api.GetCurrentProcess();
      return Boolean(api.SetProcessWorkingSetSize(hProcess, -1, -1));
    } catch (err) {
      logger(`[memoryTrimmer] Failed to trim current process: ${err.message}`);
      return false;
    }
  }

  function trimProcessById(pid) {
    if (!pid || pid === process.pid) return trimCurrentProcess();
    const api = getApi();
    if (!api) return false;
    try {
      const hProcess = api.OpenProcess(PROCESS_SET_QUOTA | PROCESS_QUERY_INFORMATION, 0, pid);
      if (!hProcess) return false;
      try {
        return Boolean(api.SetProcessWorkingSetSize(hProcess, -1, -1));
      } finally {
        api.CloseHandle(hProcess);
      }
    } catch (err) {
      logger(`[memoryTrimmer] Failed to trim pid ${pid}: ${err.message}`);
      return false;
    }
  }

  function trimAllProcesses() {
    if (!isWindows) return;
    if (typeof global.gc === 'function') {
      try { global.gc(); } catch (_) {}
    }

    // Trim main process first
    trimCurrentProcess();

    // Trim all child processes (Renderer, GPU, Utility/Network, etc.)
    if (app && typeof app.getAppMetrics === 'function') {
      try {
        const metrics = app.getAppMetrics();
        if (Array.isArray(metrics)) {
          for (const metric of metrics) {
            if (metric?.pid && metric.pid !== process.pid) {
              trimProcessById(metric.pid);
            }
          }
        }
      } catch (err) {
        logger(`[memoryTrimmer] Failed to trim app metrics: ${err.message}`);
      }
    }
  }

  function scheduleTrim(delayMs = 1200) {
    if (!isWindows) return;
    if (trimTimer) clearTimeout(trimTimer);
    trimTimer = setTimeout(() => {
      trimTimer = null;
      trimAllProcesses();
    }, delayMs);
    if (typeof trimTimer.unref === 'function') {
      trimTimer.unref();
    }
  }

  function startPeriodicTrim({ intervalMs = 15 * 60 * 1000, shouldTrim = () => true } = {}) {
    if (!isWindows) return;
    stopPeriodicTrim();
    periodicTimer = setInterval(() => {
      if (typeof shouldTrim === 'function' && !shouldTrim()) return;
      trimAllProcesses();
    }, intervalMs);
    if (typeof periodicTimer.unref === 'function') {
      periodicTimer.unref();
    }
  }

  function stopPeriodicTrim() {
    if (periodicTimer) {
      clearInterval(periodicTimer);
      periodicTimer = null;
    }
  }

  function destroy() {
    if (trimTimer) {
      clearTimeout(trimTimer);
      trimTimer = null;
    }
    stopPeriodicTrim();
  }

  return {
    trimCurrentProcess,
    trimProcessById,
    trimAllProcesses,
    scheduleTrim,
    startPeriodicTrim,
    stopPeriodicTrim,
    destroy
  };
}

module.exports = {
  createMemoryTrimmer
};
