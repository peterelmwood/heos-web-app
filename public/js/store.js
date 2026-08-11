/**
 * Application state plus the actions that mutate it.
 *
 * Views subscribe to named topics (`players`, `queue`, `progress`, …) so a
 * once-a-second progress tick never forces a full re-render.
 */

import { api } from './api.js';

const TARGET_KEY = 'heos.targetPid';

class Emitter {
  constructor() {
    this.listeners = new Map();
  }

  on(topic, handler) {
    const set = this.listeners.get(topic) ?? new Set();
    set.add(handler);
    this.listeners.set(topic, set);
    return () => set.delete(handler);
  }

  emit(topic, detail) {
    for (const handler of this.listeners.get(topic) ?? []) {
      try {
        handler(detail);
      } catch (err) {
        console.error(`listener for "${topic}" failed`, err);
      }
    }
  }
}

export const store = new Emitter();

export const state = {
  ready: false,
  status: { connected: false, mode: 'connecting', discovered: [] },
  players: [],
  groups: [],
  sources: [],
  /** Player that browse actions send music to. */
  targetPid: Number(localStorage.getItem(TARGET_KEY)) || null,
  queue: { pid: null, items: [], total: 0 },
  /** pid → {position, duration} from `player_now_playing_progress`. */
  progress: new Map(),
  tab: 'music',
};

export const getPlayer = (pid) => state.players.find((player) => player.pid === Number(pid)) ?? null;
export const targetPlayer = () => getPlayer(state.targetPid) ?? state.players[0] ?? null;

/** Players that are group members but not the leader — hidden from Rooms. */
export function groupOf(pid) {
  return state.groups.find((group) => group.players.some((member) => member.pid === Number(pid))) ?? null;
}

/** The player that actually accepts transport commands for a room. */
export function controlPid(pid) {
  const group = groupOf(pid);
  return group ? group.leader ?? group.players[0].pid : Number(pid);
}

export function setTab(tab) {
  if (state.tab === tab) return;
  state.tab = tab;
  store.emit('tab', tab);
}

export function setTarget(pid) {
  state.targetPid = Number(pid);
  localStorage.setItem(TARGET_KEY, String(pid));
  store.emit('target', state.targetPid);
  store.emit('players', state.players);
}

export function setStatus(status) {
  state.status = status;
  store.emit('status', status);
}

export async function refreshStatus() {
  setStatus(await api.status());
  return state.status;
}

export async function refreshPlayers() {
  const { players, groups } = await api.players();
  state.players = players;
  state.groups = groups;
  if (!state.players.some((player) => player.pid === state.targetPid)) {
    state.targetPid = players[0]?.pid ?? null;
    if (state.targetPid) localStorage.setItem(TARGET_KEY, String(state.targetPid));
    store.emit('target', state.targetPid);
  }
  store.emit('players', players);
  return players;
}

export async function refreshSources(refresh = false) {
  const { sources } = await api.sources(refresh);
  state.sources = sources;
  store.emit('sources', sources);
  return sources;
}

export async function refreshQueue(pid = state.targetPid) {
  if (!pid) return state.queue;
  const queue = await api.queue(pid, { count: 300 });
  state.queue = { pid: Number(pid), items: queue.items, total: queue.total ?? queue.items.length };
  store.emit('queue', state.queue);
  return state.queue;
}

/** Merge a freshly fetched player state (from a WebSocket event) into the list. */
export function mergePlayerState(pid, patch) {
  const index = state.players.findIndex((player) => player.pid === Number(pid));
  if (index === -1) return;
  state.players[index] = { ...state.players[index], ...patch };
  store.emit('players', state.players);
}

export function setProgress(pid, position, duration) {
  state.progress.set(Number(pid), { position, duration });
  store.emit('progress', { pid: Number(pid), position, duration });
}

/** Optimistic volume so dragging a slider feels immediate. */
export function setLocalVolume(pid, level) {
  mergePlayerState(pid, { volume: level });
}
