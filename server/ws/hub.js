/**
 * Pushes HEOS change events to every open browser tab.
 *
 * The device only tells us *that* something changed, so events that matter to
 * the UI are enriched with the new state before they go out. Progress ticks
 * are forwarded untouched — they arrive once a second and already carry
 * everything the progress bar needs.
 */

import { WebSocketServer } from 'ws';
import { manager } from '../heos/manager.js';

/** Events that are worth a follow-up query before broadcasting. */
const ENRICHED = new Set([
  'player_state_changed',
  'player_now_playing_changed',
  'player_volume_changed',
  'repeat_mode_changed',
  'shuffle_mode_changed',
]);

export function attachWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  const broadcast = (message) => {
    const data = JSON.stringify(message);
    for (const socket of wss.clients) {
      if (socket.readyState === socket.OPEN) socket.send(data);
    }
  };

  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'status', status: manager.status }));
    socket.on('message', (raw) => {
      // The only client message is a keepalive ping.
      try {
        if (JSON.parse(String(raw)).type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
      } catch {
        /* ignore malformed frames */
      }
    });
  });

  manager.on('status', (status) => broadcast({ type: 'status', status }));
  manager.on('log', (message) => broadcast({ type: 'log', message }));

  manager.on('heos-event', async (event) => {
    if (!ENRICHED.has(event.type) || !event.pid) {
      broadcast({ type: 'event', event });
      return;
    }
    try {
      const state = await manager.require().getPlayerState(event.pid);
      broadcast({ type: 'event', event, state });
    } catch {
      broadcast({ type: 'event', event });
    }
  });

  return wss;
}
