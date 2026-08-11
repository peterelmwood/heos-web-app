/**
 * WebSocket bridge: turns HEOS change events into store updates.
 *
 * Reconnects on its own so the UI recovers when the server restarts or the
 * laptop wakes from sleep.
 */

import {
  mergePlayerState,
  refreshPlayers,
  refreshQueue,
  refreshSources,
  setProgress,
  setStatus,
  state,
  store,
} from './store.js';

let socket = null;
let retry = 0;
let reconnectTimer = null;

export function connectEvents() {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  socket = new WebSocket(url);

  socket.addEventListener('open', () => {
    retry = 0;
    store.emit('socket', { connected: true });
  });

  socket.addEventListener('close', () => {
    store.emit('socket', { connected: false });
    scheduleReconnect();
  });

  socket.addEventListener('error', () => socket?.close());

  socket.addEventListener('message', (message) => {
    let data;
    try {
      data = JSON.parse(message.data);
    } catch {
      return;
    }
    if (data.type === 'status') {
      const wasConnected = state.status.connected;
      setStatus(data.status);
      if (!wasConnected && data.status.connected) void reloadEverything();
    } else if (data.type === 'log') {
      console.info('[heos]', data.message);
    } else if (data.type === 'event') {
      handleHeosEvent(data.event, data.state);
    }
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  retry += 1;
  reconnectTimer = setTimeout(connectEvents, Math.min(15_000, 500 * 2 ** Math.min(retry, 5)));
}

async function reloadEverything() {
  try {
    await refreshPlayers();
    await refreshSources();
  } catch (err) {
    console.warn('Failed to reload after reconnect', err);
  }
}

function handleHeosEvent(event, playerState) {
  switch (event.type) {
    case 'player_now_playing_progress':
      setProgress(event.pid, event.cur_pos, event.duration);
      break;

    case 'player_state_changed':
    case 'player_now_playing_changed':
    case 'player_volume_changed':
    case 'repeat_mode_changed':
    case 'shuffle_mode_changed':
      if (playerState) mergePlayerState(event.pid, playerState);
      if (event.type === 'player_now_playing_changed') {
        setProgress(event.pid, 0, playerState?.duration ?? 0);
        if (Number(event.pid) === Number(state.queue.pid)) void refreshQueue(event.pid).catch(() => {});
      }
      break;

    case 'player_queue_changed':
      if (Number(event.pid) === Number(state.queue.pid)) void refreshQueue(event.pid).catch(() => {});
      store.emit('queue-changed', { pid: Number(event.pid) });
      break;

    case 'players_changed':
    case 'groups_changed':
      void refreshPlayers().catch(() => {});
      break;

    case 'sources_changed':
    case 'user_changed':
      void refreshSources(true).catch(() => {});
      break;

    case 'player_playback_error':
      store.emit('error', event.error ?? 'Playback error');
      break;

    case 'connection_changed':
      if (event.connected) void reloadEverything();
      break;

    default:
      break;
  }
}
