/**
 * Browser tests: drive the real UI against the real server in Chromium.
 *
 * Everything here covers behaviour that only exists once a DOM, a pointer and
 * a live WebSocket are involved — request coalescing during a drag, a view
 * rebuilding underneath the control the user is holding, events arriving from
 * the device. None of it is reachable from an in-process test, and each of
 * these assertions corresponds to a bug that shipped and had to be fixed.
 *
 * Skipped automatically when no Chromium is available; run
 * `npx playwright install chromium` to enable them.
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import { launchChromium, until, withServer } from './helpers.js';

const PORT = 3421;
const BASE = `http://127.0.0.1:${PORT}`;

/** @type {import('playwright').Browser | null} */
let browser;
let server;
let stopServer;

before(async () => {
  browser = await launchChromium();
  if (!browser) return;
  // Keep one server up for the whole file; each test gets a fresh page.
  let release;
  const finished = new Promise((resolve) => {
    release = resolve;
  });
  server = withServer({ port: PORT }, () => finished);
  stopServer = release;
  await until(
    async () => {
      try {
        return (await fetch(`${BASE}/api/status`)).ok;
      } catch {
        return false;
      }
    },
    { message: 'the server to accept requests' },
  );
});

after(async () => {
  stopServer?.();
  await server?.catch(() => {});
  await browser?.close();
});

/**
 * Open the app in a fresh page, failing the test on any console error.
 * Returns the page plus a counter of volume requests for throttling checks.
 */
async function openApp() {
  const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
  const errors = [];
  const volumeRequests = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('request', (request) => {
    if (request.url().includes('/volume')) volumeRequests.push(request.url());
  });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.locator('.tabbar').waitFor();
  return { page, errors, volumeRequests };
}

const deviceVolume = async (name) => {
  const { players } = await (await fetch(`${BASE}/api/players`)).json();
  return players.find((player) => player.name === name).volume;
};

/** Drag a range input from its left edge to its right edge in `steps` moves. */
async function dragToMax(page, slider, steps = 40) {
  const box = await slider.boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 5, y);
  await page.mouse.down();
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(box.x + 5 + ((box.width - 10) * step) / steps, y);
    await page.waitForTimeout(8);
  }
  await page.mouse.up();
}

/** Play the first track in Local Music → Songs, from the Music tab. */
async function playFirstSong(page) {
  await page.locator('.tab[data-tab="music"]').click();
  await page.getByText('Local Music', { exact: true }).click();
  await page.getByText('Songs', { exact: true }).click();
  const first = page.locator('#screen-music .rows .row').first();
  await first.waitFor();
  const title = await first.locator('.row__title').innerText();
  await first.click();
  return title;
}

describe('browser', { skip: process.env.HEOS_SKIP_BROWSER_TESTS === '1' }, () => {
  test('selects music the way the mobile app does', async (t) => {
    if (!browser) return t.skip('no Chromium available');
    const { page, errors } = await openApp();
    try {
      // Sources the HEOS app shows, including an unavailable service.
      const sources = await page.locator('#screen-music .row__title').allInnerTexts();
      for (const expected of ['Local Music', 'Playlists', 'History', 'HEOS Favorites', 'AUX Input', 'TuneIn']) {
        assert.ok(sources.includes(expected), `expected source ${expected} in ${sources.join(', ')}`);
      }
      const spotifyRow = page.locator('#screen-music .row', { hasText: 'Spotify' });
      // `innerText` is the rendered text, so the badge arrives uppercased by CSS.
      assert.match(await spotifyRow.innerText(), /sign in required/i);
      assert.equal(await spotifyRow.isDisabled(), true, 'unavailable sources are not browsable');

      // Drill down: source → Artists → artist → album → tracks.
      await page.getByText('Local Music', { exact: true }).click();
      await page.getByText('Artists', { exact: true }).click();
      await page.locator('#screen-music .rows .row').first().click();
      await page.locator('#screen-music .rows .row').first().click();
      await page.locator('.hero__title').waitFor();
      assert.equal(await page.locator('.hero__kind').innerText(), 'ALBUM');
      const trackCount = await page.locator('#screen-music .rows .row').count();
      assert.ok(trackCount > 1, 'album should list its tracks');

      // Back button unwinds the navigation stack.
      await page.locator('#screen-music .header button[aria-label="Back"]').click();
      assert.equal(await page.locator('.hero__kind').innerText(), 'ARTIST');

      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });

  test('the row action sheet offers the four HEOS add-criteria', async (t) => {
    if (!browser) return t.skip('no Chromium available');
    const { page, errors } = await openApp();
    try {
      await page.locator('.tab[data-tab="music"]').click();
      await page.getByText('Local Music', { exact: true }).click();
      await page.getByText('Songs', { exact: true }).click();
      await page.locator('#screen-music .rows .row').first().locator('button.iconbtn').click();
      await page.locator('.sheet').waitFor();

      const actions = await page.locator('.sheet__item').allInnerTexts();
      for (const expected of ['Play Now', 'Play Next', 'Add to End of Queue', 'Replace Queue and Play']) {
        assert.ok(actions.includes(expected), `expected action ${expected} in ${actions.join(', ')}`);
      }

      await page.getByRole('button', { name: 'Add to End of Queue' }).click();
      const queued = await until(
        async () => {
          const queue = await (await fetch(`${BASE}/api/players/100001/queue`)).json();
          return queue.items.length > 0 ? queue : null;
        },
        { message: 'the track to reach the queue' },
      );
      assert.equal(queued.items.length, 1);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });

  test('playing a track updates the mini player and Now Playing', async (t) => {
    if (!browser) return t.skip('no Chromium available');
    const { page, errors } = await openApp();
    try {
      const title = await playFirstSong(page);

      const mini = page.locator('.mini__title');
      await mini.waitFor();
      assert.equal(await mini.innerText(), title);

      await page.locator('.tab[data-tab="now"]').click();
      assert.equal(await page.locator('.np__title').innerText(), title);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });

  test('progress ticks from device events, not a local timer', async (t) => {
    if (!browser) return t.skip('no Chromium available');
    const { page, errors } = await openApp();
    try {
      await playFirstSong(page);
      await page.locator('.tab[data-tab="now"]').click();

      const elapsed = () => page.locator('.np__times span').first().innerText();
      const first = await elapsed();
      // Only `player_now_playing_progress` over the WebSocket moves this, so a
      // change proves broadcasts are reaching the browser.
      const advanced = await until(async () => (await elapsed()) !== first, {
        message: 'the progress readout to advance',
        timeout: 6000,
      });
      assert.ok(advanced);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });

  test('dragging the Now Playing volume coalesces requests and lands where released', async (t) => {
    if (!browser) return t.skip('no Chromium available');
    const { page, errors, volumeRequests } = await openApp();
    try {
      await playFirstSong(page);
      await page.locator('.tab[data-tab="now"]').click();
      const slider = page.locator('#screen-now .np__volume input[type=range]');
      await slider.waitFor();

      await dragToMax(page, slider, 40);

      // Regression: the optimistic update re-rendered the view mid-drag, which
      // tore out the slider and left it at 0 instead of 100.
      assert.equal(await slider.inputValue(), '100', 'slider should stay where the drag ended');
      assert.equal(
        await until(async () => ((await deviceVolume('Living Room')) === 100 ? 100 : null), {
          message: 'the device to reach the released value',
        }),
        100,
      );
      // Regression: one request per `input` event meant ~40 serialised commands.
      assert.ok(
        volumeRequests.length < 15,
        `a 40-step drag should coalesce, sent ${volumeRequests.length} requests`,
      );
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });

  test('dragging a Rooms volume behaves the same and updates its readout', async (t) => {
    if (!browser) return t.skip('no Chromium available');
    const { page, errors, volumeRequests } = await openApp();
    try {
      await page.locator('.tab[data-tab="rooms"]').click();
      const slider = page.getByRole('slider', { name: 'Volume for Kitchen' });
      await slider.waitFor();

      await dragToMax(page, slider, 40);

      assert.equal(await slider.inputValue(), '100');
      assert.equal(
        await until(async () => ((await deviceVolume('Kitchen')) === 100 ? 100 : null), {
          message: 'the Kitchen volume to reach 100',
        }),
        100,
      );
      assert.ok(volumeRequests.length < 15, `sent ${volumeRequests.length} requests`);

      const card = page.locator('.roomcard').filter({ hasText: 'Kitchen' });
      assert.equal(await card.locator('.volume span').first().innerText(), '100');
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });

  test('keyboard volume adjustment registers every keypress', async (t) => {
    if (!browser) return t.skip('no Chromium available');
    const { page, errors } = await openApp();
    try {
      await page.locator('.tab[data-tab="rooms"]').click();
      const slider = page.getByRole('slider', { name: 'Volume for Patio' });
      await slider.waitFor();
      const before = Number(await slider.inputValue());

      await slider.focus();
      for (let press = 0; press < 5; press += 1) await page.keyboard.press('ArrowLeft');

      // Regression: ending the interaction on keyup let the view rebuild
      // between presses, destroying the focused element, so only the first
      // ArrowLeft ever registered.
      const expected = before - 5;
      assert.equal(
        await until(async () => (Number(await slider.inputValue()) === expected ? expected : null), {
          message: `the slider to reach ${expected}`,
        }),
        expected,
      );
      assert.equal(
        await until(async () => ((await deviceVolume('Patio')) === expected ? expected : null), {
          message: 'the device to catch up with the keyboard',
        }),
        expected,
      );
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });

  test('the view resumes live updates once the interaction ends', async (t) => {
    if (!browser) return t.skip('no Chromium available');
    const { page, errors } = await openApp();
    try {
      await page.locator('.tab[data-tab="rooms"]').click();
      const slider = page.getByRole('slider', { name: 'Volume for Study' });
      await dragToMax(page, slider, 10);

      // Suppressing rebuilds during a gesture must not leave the view frozen.
      const title = await playFirstSong(page);
      await page.locator('.tab[data-tab="rooms"]').click();
      const living = page.locator('.roomcard').filter({ hasText: 'Living Room' });
      const line = await until(
        async () => {
          const text = await living.locator('.roomcard__now').innerText();
          return text.includes(title) ? text : null;
        },
        { message: 'the Rooms card to show the new track' },
      );
      assert.match(line, new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });

  test('search returns matches and plays a station', async (t) => {
    if (!browser) return t.skip('no Chromium available');
    const { page, errors } = await openApp();
    try {
      await page.locator('.tab[data-tab="music"]').click();
      await page.getByText('TuneIn', { exact: true }).click();
      await page.locator('#screen-music .searchbar input').waitFor();
      await page.locator('#screen-music .searchbar input').fill('jazz');

      const results = await until(
        async () => {
          const titles = await page.locator('#screen-music .rows .row__title').allInnerTexts();
          return titles.length === 1 && titles[0] === 'Jazz24' ? titles : null;
        },
        { message: 'the search results to narrow to Jazz24' },
      );
      assert.deepEqual(results, ['Jazz24']);

      await page.locator('#screen-music .rows .row').first().click();
      const nowPlaying = await until(
        async () => {
          const player = await (await fetch(`${BASE}/api/players/100001`)).json();
          return player.nowPlaying?.type === 'station' ? player.nowPlaying : null;
        },
        { message: 'the station to start playing' },
      );
      assert.equal(nowPlaying.station, 'Jazz24');
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
});
