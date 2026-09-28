'use strict';

(function exposeVisibilityRefresh(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorVisibilityRefresh = api;
})(typeof window !== 'undefined' ? window : null, function createApi() {
  function sync({ hidden, pause, startTimer, refreshStats }) {
    if (hidden) {
      pause();
      return;
    }
    startTimer();
    void refreshStats();
  }
  return { isPaused: (hidden) => Boolean(hidden), sync };
});
