/**
 * A single TCP connection to a HEOS device's CLI port.
 *
 * HEOS speakers process one command at a time, so commands are queued and
 * dispatched serially. Responses are correlated with the in-flight command by
 * comparing the command path; anything that arrives while nothing is in flight
 * (or that starts with `event/`) is emitted as an event instead.
 */

import net from 'node:net';
import { EventEmitter } from 'node:events';
import {
  HEOS_PORT,
  buildCommand,
  parseResponse,
  responseError,
} from './protocol.js';

const DEFAULT_TIMEOUT = 15_000;
/** Browse calls against cloud services can be slow; give them more room. */
const SLOW_COMMANDS = new Set(['browse/browse', 'browse/search', 'browse/get_music_sources']);
const SLOW_TIMEOUT = 45_000;
/** The CLI drops idle connections, so poke it periodically. */
const HEARTBEAT_INTERVAL = 20_000;

export class HeosConnection extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.host device address
   * @param {number} [options.port]
   * @param {boolean} [options.autoReconnect]
   */
  constructor({ host, port = HEOS_PORT, autoReconnect = true }) {
    super();
    this.host = host;
    this.port = port;
    this.autoReconnect = autoReconnect;
    this.socket = null;
    this.connected = false;
    this.closing = false;
    this.buffer = '';
    /** @type {Array<{path: string, attrs: object, resolve: Function, reject: Function}>} */
    this.queue = [];
    this.inFlight = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
  }

  connect() {
    if (this.socket) return this.readyPromise ?? Promise.resolve();
    this.closing = false;
    this.readyPromise = new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      this.socket = socket;
      socket.setEncoding('utf8');
      socket.setKeepAlive(true, 10_000);

      const onError = (err) => {
        if (!this.connected) reject(err);
        this.#handleError(err);
      };

      socket.once('connect', () => {
        this.connected = true;
        this.reconnectAttempts = 0;
        this.#startHeartbeat();
        this.emit('connect');
        resolve();
      });
      socket.on('data', (chunk) => this.#handleData(chunk));
      socket.on('error', onError);
      socket.on('close', () => this.#handleClose());
    });
    return this.readyPromise;
  }

  /**
   * Send a command and resolve with the parsed response.
   *
   * @param {string} path e.g. `player/get_players`
   * @param {Record<string, unknown>} [attrs]
   * @returns {Promise<import('./protocol.js').parseResponse extends never ? never : any>}
   */
  send(path, attrs = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ path, attrs, resolve, reject });
      this.#pump();
    });
  }

  async close() {
    this.closing = true;
    this.autoReconnect = false;
    clearTimeout(this.reconnectTimer);
    this.#stopHeartbeat();
    const socket = this.socket;
    this.socket = null;
    this.readyPromise = null;
    if (socket) {
      await new Promise((resolve) => {
        socket.end(resolve);
        socket.unref?.();
        setTimeout(resolve, 250).unref?.();
      });
      socket.destroy();
    }
    this.connected = false;
  }

  #pump() {
    if (this.inFlight || !this.queue.length || !this.connected || !this.socket) return;
    const entry = this.queue.shift();
    this.inFlight = entry;
    const timeoutMs = SLOW_COMMANDS.has(entry.path) ? SLOW_TIMEOUT : DEFAULT_TIMEOUT;
    entry.timer = setTimeout(() => {
      this.inFlight = null;
      entry.reject(new Error(`Timed out waiting for ${entry.path}`));
      this.#pump();
    }, timeoutMs);
    entry.timer.unref?.();
    this.socket.write(`${buildCommand(entry.path, entry.attrs)}\r\n`);
  }

  #handleData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\r\n')) !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      if (line.trim()) this.#handleLine(line);
    }
    // Guard against a device that never sends a terminator.
    if (this.buffer.length > 1_000_000) this.buffer = '';
  }

  #handleLine(line) {
    let response;
    try {
      response = parseResponse(line);
    } catch {
      this.emit('parseError', line);
      return;
    }

    if (response.isEvent) {
      this.emit('event', response);
      return;
    }

    const entry = this.inFlight;
    if (!entry) {
      this.emit('unsolicited', response);
      return;
    }

    // Long running browses acknowledge first and answer for real afterwards.
    if (response.underProcess) return;

    if (entry.path !== response.command) {
      // Out of band response for a command we already gave up on.
      this.emit('unsolicited', response);
      return;
    }

    clearTimeout(entry.timer);
    this.inFlight = null;
    if (response.success) entry.resolve(response);
    else entry.reject(responseError(response));
    this.#pump();
  }

  #handleError(err) {
    this.emit('error', err);
  }

  #handleClose() {
    const wasConnected = this.connected;
    this.connected = false;
    this.#stopHeartbeat();
    this.socket = null;
    this.readyPromise = null;

    const failure = new Error('HEOS connection closed');
    if (this.inFlight) {
      clearTimeout(this.inFlight.timer);
      this.inFlight.reject(failure);
      this.inFlight = null;
    }
    for (const entry of this.queue.splice(0)) entry.reject(failure);

    if (wasConnected) this.emit('disconnect');
    if (this.autoReconnect && !this.closing) this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    this.reconnectAttempts += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempts, 5));
    this.emit('reconnecting', { attempt: this.reconnectAttempts, delay });
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {
        /* handled by the close handler */
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send('system/heart_beat').catch(() => {
        /* the close handler deals with dead sockets */
      });
    }, HEARTBEAT_INTERVAL);
    this.heartbeatTimer.unref?.();
  }

  #stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}
