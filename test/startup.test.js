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

/** Spawn the server, wait for it to answer, then shut it down. */
async function launch({ entry = path.join(projectRoot, 'server/index.js'), cwd = projectRoot, port }) {
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: { ...process.env, HEOS_MOCK: '1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });

  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));

  try {
    const deadline = Date.now() + 15_000;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`Server never came up. Output:\n${output}`);
      // A silent exit is the failure this test exists to catch — report it now
      // rather than after a 15s timeout.
      const code = await Promise.race([exited, Promise.resolve(undefined)]);
      if (code !== undefined) {
        throw new Error(`Server exited with code ${code} without serving. Output:\n${output || '(no output)'}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/status`);
        if (response.ok) return { status: await response.json(), output };
      } catch {
        /* not listening yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
}

test('`node server/index.js` starts the server and serves the API', async () => {
  const { status } = await launch({ port: 3411 });
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
    const { status } = await launch({
      entry: path.join(link, 'server/index.js'),
      cwd: link,
      port: 3412,
    });
    assert.equal(status.connected, true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
