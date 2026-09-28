'use strict';

function createRendererStatsGate({ send, isVisible, needsTrayIcon }) {
  let pending = null;
  let deliveredInitial = false;

  function push(payload) {
    if (!deliveredInitial || isVisible() || needsTrayIcon()) {
      send(payload);
      pending = null;
      deliveredInitial = true;
      return true;
    }
    pending = payload;
    return false;
  }

  function flush() {
    if (!pending) return false;
    send(pending);
    pending = null;
    return true;
  }

  return { push, flush };
}

module.exports = { createRendererStatsGate };
