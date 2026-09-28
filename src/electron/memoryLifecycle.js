'use strict';

const { createMemoryTrimmer } = require('./memoryTrimmer');

function createMemoryLifecycle({ app, platform = process.platform }) {
  app.commandLine.appendSwitch('js-flags', '--max-old-space-size=128 --expose-gc');
  app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess');
  app.commandLine.appendSwitch('renderer-process-limit', '1');

  const trimmer = createMemoryTrimmer({ app, platform });
  function trimSoon() { trimmer.scheduleTrim(1200); }
  function trimAfterStartup(getWindow) {
    setTimeout(() => {
      const win = getWindow();
      if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) {
        trimmer.scheduleTrim(1000);
      }
    }, 5000);
  }
  return { trimSoon, trimAfterStartup, destroy: () => trimmer.destroy() };
}

module.exports = { createMemoryLifecycle };
