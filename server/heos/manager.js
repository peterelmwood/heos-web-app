/**
 * Owns the lifecycle of the single {@link HeosClient} the web app talks to.
 *
 * Resolution order: an explicitly configured host, then SSDP discovery, then
 * (unless disabled) the built-in simulator so the UI is always usable.
 */

import { EventEmitter } from 'node:events';
import { HeosClient } from './client.js';
import { discoverDevices } from './discovery.js';
import { MockHeosDevice } from './mock/device.js';
import { config } from '../config.js';

export class HeosManager extends EventEmitter {
  constructor() {
    super();
    /** @type {HeosClient | null} */
    this.client = null;
    /** @type {MockHeosDevice | null} */
    this.mockDevice = null;
    this.mode = 'disconnected';
    this.deviceName = null;
    this.lastError = null;
    this.discovered = [];
    this.connecting = null;
  }

  get status() {
    return {
      connected: Boolean(this.client?.connected),
      mode: this.mode,
      host: this.client?.host ?? null,
      deviceName: this.deviceName,
      account: this.client?.signedInUser ?? null,
      error: this.lastError,
      discovered: this.discovered,
    };
  }

  /** Connect using the configured strategy. Safe to call repeatedly. */
  async init() {
    if (this.connecting) return this.connecting;
    this.connecting = this.#init().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async #init() {
    this.lastError = null;
    this.mode = 'connecting';
    this.emit('status', this.status);

    if (config.mock) return this.#startMock('Simulator requested via HEOS_MOCK');

    if (config.heosHost) {
      try {
        await this.connectTo(config.heosHost, { port: config.heosPort, mode: 'device' });
        return this.status;
      } catch (err) {
        this.lastError = `Could not reach ${config.heosHost}: ${err.message}`;
        this.emit('log', this.lastError);
      }
    } else {
      try {
        this.discovered = await discoverDevices({ timeout: config.discoveryTimeout });
      } catch (err) {
        this.discovered = [];
        this.emit('log', `Discovery failed: ${err.message}`);
      }
      if (this.discovered.length) {
        const device = this.discovered[0];
        try {
          await this.connectTo(device.host, { port: config.heosPort, mode: 'device', name: device.name });
          return this.status;
        } catch (err) {
          this.lastError = `Found ${device.host} but the CLI port refused the connection: ${err.message}`;
          this.emit('log', this.lastError);
        }
      } else {
        this.lastError = 'No HEOS devices answered discovery on this network.';
      }
    }

    if (config.mockFallback) return this.#startMock(this.lastError ?? 'No devices found');
    this.mode = 'disconnected';
    this.emit('status', this.status);
    return this.status;
  }

  async #startMock(reason) {
    this.emit('log', `Starting the HEOS simulator (${reason}).`);
    this.mockDevice = new MockHeosDevice({ host: '127.0.0.1', port: 0 });
    const { host, port } = await this.mockDevice.start();
    await this.connectTo(host, { port, mode: 'mock', name: 'HEOS Simulator' });
    return this.status;
  }

  /**
   * Point the app at a specific device, tearing down any existing connection.
   * @param {string} host
   */
  async connectTo(host, { port = config.heosPort, mode = 'device', name = null } = {}) {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
    if (mode !== 'mock' && this.mockDevice) {
      await this.mockDevice.stop();
      this.mockDevice = null;
    }

    const client = new HeosClient({ host, port });
    client.on('event', (event) => this.emit('heos-event', event));
    client.on('connected', () => {
      this.emit('status', this.status);
      this.emit('heos-event', { type: 'connection_changed', connected: true });
    });
    client.on('disconnected', () => {
      this.emit('status', this.status);
      this.emit('heos-event', { type: 'connection_changed', connected: false });
    });
    client.on('reconnecting', (info) => this.emit('log', `Reconnecting in ${info.delay}ms (attempt ${info.attempt})`));
    client.on('warning', (err) => this.emit('log', `HEOS warning: ${err.message}`));

    await client.connect();
    this.client = client;
    this.mode = mode;
    this.deviceName = name;
    this.lastError = null;

    if (mode !== 'mock' && config.account.username && config.account.password) {
      try {
        await client.signIn(config.account.username, config.account.password);
      } catch (err) {
        this.emit('log', `HEOS account sign-in failed: ${err.message}`);
      }
    }

    this.emit('status', this.status);
    return this.status;
  }

  /** Re-run SSDP without disturbing the current connection. */
  async rediscover() {
    this.discovered = await discoverDevices({ timeout: config.discoveryTimeout });
    this.emit('status', this.status);
    return this.discovered;
  }

  /** @returns {HeosClient} */
  require() {
    if (!this.client?.connected) {
      const error = new Error('Not connected to a HEOS system');
      error.statusCode = 503;
      throw error;
    }
    return this.client;
  }

  async shutdown() {
    await this.client?.close();
    await this.mockDevice?.stop();
    this.client = null;
    this.mockDevice = null;
    this.mode = 'disconnected';
  }
}

export const manager = new HeosManager();
