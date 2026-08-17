/**
 * Launch tests: spawn the server the way a user does and prove it serves.
 *
 * These exist because a broken entry-point check makes the process load, do
 * nothing, and exit 0 — which looks identical to a clean shutdown and is
 * invisible to every in-process test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { projectRoot, withServer } from './helpers.js';

test('`node server/index.js` starts the server and serves the API', async () => {
  const status = await withServer({ port: 3411 });
  assert.equal(status.connected, true);
  assert.equal(status.mode, 'mock');
});

test('starts from a path containing a space and a symlink', async () => {
  // Reproduces the real failure: `import.meta.url` percent-encodes the space
  // and resolves the symlink, so a naive comparison against argv[1] is false
  // and the process would exit having started nothing.
  const base = mkdtempSync(path.join(tmpdir(), 'heos test '));
  const link = path.join(base, 'linked project');
  symlinkSync(projectRoot, link);
  try {
    const status = await withServer({
      entry: path.join(link, 'server/index.js'),
      cwd: link,
      port: 3412,
    });
    assert.equal(status.connected, true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('bad input is rejected by the API rather than forwarded to the device', async () => {
  await withServer({ port: 3413 }, async ({ baseUrl }) => {
    const get = (url) => fetch(`${baseUrl}${url}`);

    const badPid = await get('/api/players/not-a-number');
    assert.equal(badPid.status, 400);
    assert.match((await badPid.json()).error, /Invalid player id/);

    const negativePid = await get('/api/players/-5/queue');
    assert.equal(negativePid.status, 400);

    const missingSid = await get('/api/browse');
    assert.equal(missingSid.status, 400);

    const unknownRoute = await get('/api/nope');
    assert.equal(unknownRoute.status, 404);
    assert.match((await unknownRoute.json()).error, /No such endpoint/);

    // A valid pid still works, so the guard is not over-eager.
    const players = await (await get('/api/players')).json();
    const ok = await get(`/api/players/${players.players[0].pid}`);
    assert.equal(ok.status, 200);
  });
});
