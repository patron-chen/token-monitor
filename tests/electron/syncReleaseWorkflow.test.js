'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('release needs every build to succeed', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'sync-and-release.yml'), 'utf8');
  assert.match(workflow, /needs\.build\.result == 'success'/);
});
