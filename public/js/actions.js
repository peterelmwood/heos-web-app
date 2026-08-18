/**
 * Playback actions shared by every view.
 *
 * The four add-criteria (Play Now / Play Next / Add to End / Replace Queue)
 * are exactly what the HEOS app offers behind the "…" on a browse row, so they
 * live here rather than in any one view.
 */

import { api } from './api.js';
import { showSheet } from './components/sheet.js';
import { attempt, toast } from './components/toast.js';
import { artFor } from './dom.js';
import {
  beginInteraction,
  controlPid,
  endInteraction,
  refreshQueue,
  setLocalVolume,
  setTarget,
  state,
  store,
  targetPlayer,
} from './store.js';

const ACTION_LABELS = {
  PLAY_NOW: 'Play Now',
  PLAY_NEXT: 'Play Next',
  ADD_TO_END: 'Add to End of Queue',
  REPLACE_AND_PLAY: 'Replace Queue and Play',
};

const ACTION_ICONS = {
  PLAY_NOW: 'play',
  PLAY_NEXT: 'playNext',
  ADD_TO_END: 'addEnd',
  REPLACE_AND_PLAY: 'replace',
};

const isStation = (item) => item.type === 'station';
const isInput = (item) => item.type === 'media_input' || item.type === 'input';

/**
 * Send one browse item to a player.
 *
 * @param {object} item normalised browse item
 * @param {keyof ACTION_LABELS} action
 * @param {object} [context]
 * @param {string} [context.containerCid] container the item was listed under
 * @param {number} [context.pid] override the target room
 */
export async function playItem(item, action = 'PLAY_NOW', context = {}) {
  const player = context.pid ? { pid: context.pid } : targetPlayer();
  if (!player) {
    toast('No room available to play to', { error: true });
    return null;
  }
  const pid = controlPid(player.pid);

  if (isInput(item)) {
    return attempt(() => api.play({ pid, input: item.mid, cid: item.cid }), {
      success: `Playing ${item.name}`,
    });
  }

  const payload = {
    pid,
    sid: item.sid,
    // Tracks need the container they live in; containers pass their own cid.
    cid: item.container ? item.cid : item.cid ?? context.containerCid,
    mid: item.mid,
    name: item.name,
    action,
    isStation: isStation(item),
  };

  const verb = isStation(item)
    ? `Playing ${item.name}`
    : `${ACTION_LABELS[action].replace(/ and Play$/, '')} · ${item.name}`;

  const result = await attempt(() => api.play(payload), { success: verb });
  if (result && Number(state.queue.pid) === Number(pid)) void refreshQueue(pid).catch(() => {});
  return result;
}

/**
 * The "…" action sheet for a browse row.
 *
 * @param {object} item
 * @param {object} [context]
 * @param {string} [context.containerCid]
 * @param {boolean} [context.isFavorite] rendered inside the Favorites source
 * @param {Function} [context.onChanged] called after a mutation (favourites)
 */
export function openItemActions(item, context = {}) {
  const player = targetPlayer();
  const items = [];

  if (isInput(item)) {
    items.push({
      label: `Play on ${player?.name ?? 'this room'}`,
      icon: 'play',
      onSelect: () => playItem(item, 'PLAY_NOW', context),
    });
  } else if (isStation(item)) {
    items.push({
      label: `Play on ${player?.name ?? 'this room'}`,
      icon: 'play',
      onSelect: () => playItem(item, 'PLAY_NOW', context),
    });
  } else {
    for (const action of ['PLAY_NOW', 'PLAY_NEXT', 'ADD_TO_END', 'REPLACE_AND_PLAY']) {
      items.push({
        label: ACTION_LABELS[action],
        icon: ACTION_ICONS[action],
        onSelect: () => playItem(item, action, context),
      });
    }
  }

  if (isStation(item)) {
    items.push('divider');
    if (context.isFavorite) {
      items.push({
        label: 'Remove from HEOS Favorites',
        icon: 'starOff',
        danger: true,
        onSelect: async () => {
          await attempt(() => api.removeFavorite(item.mid), { success: 'Removed from HEOS Favorites' });
          await context.onChanged?.();
        },
      });
    } else {
      items.push({
        label: 'Add to HEOS Favorites',
        icon: 'star',
        onSelect: async () => {
          await attempt(() => api.addFavorite({ sid: item.sid, mid: item.mid, name: item.name }), {
            success: 'Added to HEOS Favorites',
          });
          await context.onChanged?.();
        },
      });
    }
  }

  items.push('divider');
  items.push({
    label: `Playing to: ${player?.name ?? 'no room'}`,
    icon: 'speaker',
    onSelect: () => chooseRoom(),
  });

  showSheet({
    title: item.name,
    subtitle: item.artist ?? item.album ?? describeType(item.type),
    image: item.image ?? artFor(item.name),
    items,
  });
}

/** Action sheet listing every room, used to pick the playback target. */
export function chooseRoom({ title = 'Play music to' } = {}) {
  const items = state.players.map((player) => ({
    label: player.name,
    icon: 'speaker',
    active: player.pid === state.targetPid,
    onSelect: () => {
      setTarget(player.pid);
      toast(`Playing to ${player.name}`);
    },
  }));
  if (!items.length) items.push({ label: 'No rooms found', icon: 'info' });
  showSheet({ title, items, note: 'Music you choose is sent to this room.' });
}

export function describeType(type) {
  return (
    {
      artist: 'Artist',
      album: 'Album',
      song: 'Song',
      station: 'Station',
      genre: 'Genre',
      playlist: 'Playlist',
      container: 'Folder',
      media_input: 'Input',
      heos_server: 'Music server',
      music_service: 'Music service',
      heos_service: 'HEOS service',
      dlna_server: 'Media server',
    }[type] ?? ''
  );
}

/**
 * Volume changes, coalesced per player.
 *
 * A slider drag fires `input` on every pixel of travel; without this a single
 * gesture becomes dozens of HTTP requests, each of which turns into a command
 * the speaker has to process serially. The UI updates optimistically so the
 * thumb still tracks the finger, and at most one request per player per
 * interval reaches the device — the last value always wins.
 */
const pushVolume = throttleByKey((pid, level) => {
  api.setVolume(pid, level).catch(() => {
    /* a failed volume nudge is not worth a toast; the next event re-syncs */
  });
});

export function changeVolume(pid, level) {
  setLocalVolume(pid, level);
  pushVolume(controlPid(pid), level);
}

/**
 * Wire up a volume `<input type="range">` for a player.
 *
 * Marks the store as "being interacted with" for the duration of the gesture so
 * views hold off rebuilding the slider mid-drag, and keeps an optional readout
 * in sync while they are not re-rendering.
 *
 * @param {HTMLInputElement} slider
 * @param {number} pid
 * @param {HTMLElement} [readout] element showing the numeric level
 */
export function bindVolumeSlider(slider, pid, readout) {
  let pointerActive = false;
  let idleTimer = null;

  const stop = () => {
    clearTimeout(idleTimer);
    idleTimer = null;
    endInteraction();
  };

  // A keypress has no "release" the way a drag does: ending the interaction on
  // keyup lets the view rebuild the slider between presses, which destroys the
  // focused element and drops every key after the first. Stay active until the
  // user stops adjusting or moves focus away.
  const scheduleIdleStop = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!pointerActive) stop();
    }, 600);
  };

  slider.addEventListener('pointerdown', () => {
    pointerActive = true;
    beginInteraction();
    // Release can land outside the slider, so listen globally for this gesture.
    const release = () => {
      pointerActive = false;
      stop();
    };
    window.addEventListener('pointerup', release, { once: true });
    window.addEventListener('pointercancel', release, { once: true });
  });

  slider.addEventListener('keydown', beginInteraction);
  slider.addEventListener('blur', () => {
    pointerActive = false;
    stop();
  });

  slider.addEventListener('input', () => {
    const level = Number(slider.value);
    if (readout) readout.textContent = String(level);
    changeVolume(pid, level);
    if (!pointerActive) scheduleIdleStop();
  });
}

/**
 * Run `fn` at most once per `wait` per key, always with the newest arguments.
 * Leading call fires immediately so the first nudge is not delayed.
 */
function throttleByKey(fn, wait = 120) {
  const timers = new Map();
  const pending = new Map();
  return (key, ...args) => {
    pending.set(key, args);
    if (timers.has(key)) return;
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        const latest = pending.get(key);
        pending.delete(key);
        if (latest) fn(key, ...latest);
      }, wait),
    );
  };
}

/** Convenience used by the queue and now-playing views. */
export async function transport(pid, command) {
  const target = controlPid(pid);
  return attempt(() => {
    if (command === 'next') return api.next(target);
    if (command === 'previous') return api.previous(target);
    return api.setState(target, command);
  });
}

store.on('error', (message) => toast(String(message), { error: true }));
