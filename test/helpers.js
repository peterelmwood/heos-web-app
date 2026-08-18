/** Shared fixtures: run the real server, and drive it in a real browser. */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Spawn the server against the simulator, wait until it answers, run `body`
 * against it, then stop it. Always kills the child, even if `body` throws.
 *
 * @param {object} options
 * @param {string} [options.entry] script to run
 * @param {string} [options.cwd]
 * @param {number} options.port
 * @param {(context: {port: number, baseUrl: string, status: object}) => Promise<unknown>} [body]
 */
export async function withServer({ entry = path.join(projectRoot, 'server/index.js'), cwd = projectRoot, port }, body) {
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
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const deadline = Date.now() + 15_000;
    let status;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`Server never came up. Output:\n${output || '(no output)'}`);
      // A silent exit is a failure these tests exist to catch, so report it
      // immediately rather than waiting out the deadline. `exitCode` stays null
      // until the child exits; `signalCode` covers a kill.
      if (child.exitCode !== null || child.signalCode !== null) {
        const how = child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode}`;
        throw new Error(`Server exited with ${how} without serving. Output:\n${output || '(no output)'}`);
      }
      try {
        const response = await fetch(`${baseUrl}/api/status`);
        if (response.ok) {
          status = await response.json();
          break;
        }
      } catch {
        /* not listening yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    await body?.({ port, baseUrl, status });
    return status;
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
}

/**
 * Find a Chromium that Playwright can drive.
 *
 * Playwright normally locates its own download, but CI images often ship a
 * browser built for a different Playwright release. Rather than fail, fall
 * back to whatever Chromium is on disk.
 *
 * @returns {string | undefined} an explicit executable path, or undefined to
 *   let Playwright use its own managed browser
 */
function findChromium() {
  if (process.env.HEOS_TEST_CHROMIUM) return process.env.HEOS_TEST_CHROMIUM;

  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(Boolean);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries;
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    // Prefer the full browser over the headless shell: the shell cannot
    // service the non-headless code paths if a test ever needs them.
    const candidates = entries
      .filter((entry) => entry.startsWith('chromium'))
      .sort((a, b) => Number(a.includes('headless_shell')) - Number(b.includes('headless_shell')));
    for (const candidate of candidates) {
      for (const relative of ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
        const executable = path.join(root, candidate, relative);
        if (existsSync(executable)) return executable;
      }
    }
  }
  return undefined;
}

/**
 * Launch Chromium, or return null when no browser is available.
 *
 * Browser tests are skipped rather than failed in that case: `npm install`
 * does not guarantee a downloaded browser, and a missing binary should not
 * make the whole suite red for someone who only wanted the unit tests.
 *
 * @returns {Promise<import('playwright').Browser | null>}
 */
export async function launchChromium() {
  const { chromium } = await import('playwright');
  const attempts = [undefined, findChromium()].filter((value, index, all) => all.indexOf(value) === index);
  let lastError;
  for (const executablePath of attempts) {
    try {
      return await chromium.launch(executablePath ? { executablePath } : {});
    } catch (err) {
      lastError = err;
    }
  }
  console.warn(`[browser tests] skipped — no usable Chromium (${lastError?.message?.split('\n')[0]}).`);
  console.warn('[browser tests] run `npx playwright install chromium` to enable them.');
  return null;
}

/** Poll `check` until it returns a truthy value, or throw after `timeout`. */
export async function until(check, { timeout = 10_000, interval = 100, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    last = await check();
    if (last) return last;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}. Last value: ${JSON.stringify(last)}`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
