/**
 * Launch tests: spawn the server the way a user does and prove it serves.
 *
 * These exist because a broken entry-point check makes the process load, do
 * nothing, and exit 0 — which looks identical to a clean shutdown and is
 * invisible to every in-process test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Spawn the server, wait until it answers, run `body` against it, then stop it.
 *
 * @param {object} options
 * @param {string} [options.entry] path to the script to run
 * @param {string} [options.cwd]
 * @param {number} options.port
 * @param {(context: {port: number, status: object}) => Promise<void>} [body]
 */
async function withServer({ entry = path.join(projectRoot, 'server/index.js'), cwd = projectRoot, port }, body) {
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: { ...process.env, HEOS_MOCK: '1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const collect = (chunk) => {
    output += chunk;
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const exited = new Promise((resolve) => child.once('exit', resolve));

  try {
    const deadline = Date.now() + 15_000;
    let status;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`Server never came up. Output:\n${output || '(no output)'}`);
      // A silent exit is the failure this test exists to catch, so fail on it
      // immediately rather than waiting out the deadline. `exitCode` stays null
      // until the child exits; `signalCode` covers a kill.
      if (child.exitCode !== null || child.signalCode !== null) {
        const how = child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode}`;
        throw new Error(`Server exited with ${how} without serving. Output:\n${output || '(no output)'}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/status`);
        if (response.ok) {
          status = await response.json();
          break;
        }
      } catch {
        /* not listening yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    await body?.({ port, status });
    return status;
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
}

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
  await withServer({ port: 3413 }, async ({ port }) => {
    const get = (url) => fetch(`http://127.0.0.1:${port}${url}`);

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
