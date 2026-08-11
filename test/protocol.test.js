import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCommand,
  parseAttributes,
  parseCommand,
  parseResponse,
  responseError,
  stringifyAttributes,
} from '../server/heos/protocol.js';

test('buildCommand omits empty attributes', () => {
  assert.equal(buildCommand('player/get_players'), 'heos://player/get_players');
  assert.equal(
    buildCommand('player/set_volume', { pid: 1, level: 30, cid: undefined, mid: '' }),
    'heos://player/set_volume?pid=1&level=30',
  );
});

test('buildCommand escapes only the reserved characters', () => {
  assert.equal(
    buildCommand('browse/search', { sid: 3, search: 'rock & roll 100%' }),
    'heos://browse/search?sid=3&search=rock %26 roll 100%25',
  );
});

test('parseCommand round-trips a built command', () => {
  const line = buildCommand('browse/browse', { sid: 1024, cid: 'album:1.2', range: '0,99' });
  assert.deepEqual(parseCommand(line), {
    path: 'browse/browse',
    attrs: { sid: '1024', cid: 'album:1.2', range: '0,99' },
  });
});

test('parseAttributes handles valueless attributes and encoded values', () => {
  assert.deepEqual(parseAttributes('signed_in&un=demo%40heos.local'), {
    signed_in: '',
    un: 'demo@heos.local',
  });
});

test('stringifyAttributes emits bare keys for empty values', () => {
  assert.equal(stringifyAttributes({ signed_in: '', un: 'a@b.c' }), 'signed_in&un=a@b.c');
});

test('parseResponse splits envelope, message and payload', () => {
  const line = JSON.stringify({
    heos: { command: 'player/get_volume', result: 'success', message: 'pid=1&level=30' },
    payload: [{ name: 'x' }],
  });
  const response = parseResponse(line);
  assert.equal(response.command, 'player/get_volume');
  assert.equal(response.success, true);
  assert.equal(response.isEvent, false);
  assert.deepEqual(response.message, { pid: '1', level: '30' });
  assert.deepEqual(response.payload, [{ name: 'x' }]);
});

test('parseResponse flags events and in-progress acknowledgements', () => {
  const event = parseResponse(
    JSON.stringify({ heos: { command: 'event/player_state_changed', message: 'pid=1&state=play' } }),
  );
  assert.equal(event.isEvent, true);
  assert.deepEqual(event.message, { pid: '1', state: 'play' });

  const pending = parseResponse(
    JSON.stringify({ heos: { command: 'browse/browse', result: 'success', message: 'command under process' } }),
  );
  assert.equal(pending.underProcess, true);
});

test('responseError carries the HEOS error id', () => {
  const error = responseError(
    parseResponse(JSON.stringify({ heos: { command: 'browse/browse', result: 'fail', message: 'eid=6&text=Invalid ID' } })),
  );
  assert.equal(error.eid, 6);
  assert.match(error.message, /Invalid ID/);
});
