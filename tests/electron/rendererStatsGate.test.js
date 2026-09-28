'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createRendererStatsGate } = require('../../src/electron/rendererStatsGate');
const visibilityRefresh = require('../../src/electron/renderer/visibilityRefresh');

test('renderer stats gate preserves first, tray, and latest hidden payload', () => {
  let visible = false;
  let tray = false;
  const sent = [];
  const gate = createRendererStatsGate({ send: (value) => sent.push(value), isVisible: () => visible, needsTrayIcon: () => tray });
  gate.push(1);
  gate.push(2);
  gate.push(3);
  assert.deepEqual(sent, [1]);
  gate.flush();
  assert.deepEqual(sent, [1, 3]);
  tray = true;
  gate.push(4);
  visible = true;
  gate.push(5);
  assert.deepEqual(sent, [1, 3, 4, 5]);
});

test('visibility refresh pauses hidden timers and refreshes when visible', () => {
  const calls = [];
  const options = {
    pause: () => calls.push('pause'),
    startTimer: () => calls.push('start'),
    refreshStats: () => calls.push('refresh')
  };
  visibilityRefresh.sync({ ...options, hidden: true });
  visibilityRefresh.sync({ ...options, hidden: false });
  assert.deepEqual(calls, ['pause', 'start', 'refresh']);
});
