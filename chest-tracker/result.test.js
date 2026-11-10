'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSessionId, chooseResult } = require('./result');

test('accepts a 32-character replay match ID', () => {
  assert.equal(normalizeSessionId('ABCDEF0123456789ABCDEF0123456789'), 'abcdef0123456789abcdef0123456789');
});
test('accepts a hyphenated GUID match ID', () => {
  assert.equal(normalizeSessionId('123e4567-e89b-12d3-a456-426614174000'), '123e4567e89b12d3a456426614174000');
});
test('rejects missing, malformed, or nonhex session IDs', () => {
  assert.equal(normalizeSessionId(null), null);
  assert.equal(normalizeSessionId('not-a-real-id'), null);
  assert.equal(normalizeSessionId('123456'), null);
  assert.equal(normalizeSessionId('xyz12345678901234567890123456789'), null);
});
test('prefers a resolved server replay with more chest events', () => {
  const local = { playerResolved: true, count: 5 };
  const server = { playerResolved: true, count: 8 };
  assert.equal(chooseResult(local, server).source, 'server');
});
test('never replaces a local count with an unresolved server count', () => {
  const local = { playerResolved: true, count: 5 };
  const server = { playerResolved: false, count: null };
  assert.equal(chooseResult(local, server).source, 'local');
});
test('keeps local count when the downloaded replay has fewer chest events', () => {
  assert.equal(chooseResult({playerResolved:true,count:9},
    {playerResolved:true,count:2}).source, 'local');
});
test('does not turn a missing player identity into a zero count', () => {
  const local = { playerResolved:false,count:null };
  assert.equal(chooseResult(local, null).data.count, null);
});
