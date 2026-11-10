'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { options, totals } = require('./watch');

test('watcher accepts an explicit replay folder', () => {
  const parsed = options(['--folder', './test-replays', '--no-server', '--epic-id', 'abc']);
  assert.equal(parsed.folder, path.resolve('./test-replays'));
  assert.equal(parsed.noServer, true);
  assert.equal(parsed.epicId, 'abc');
});
test('watcher total excludes unknown, failed, and unfinished matches', () => {
  const history = { matches: {
    a: { chestCount: 3, status: 'done' },
    b: { chestCount: 0, status: 'done' },
    c: { chestCount: null, status: 'done' },
    d: { error: 'parser failed', status: 'error' }
  }};
  assert.deepEqual(totals(history), { matches: 2, chests: 3 });
});
