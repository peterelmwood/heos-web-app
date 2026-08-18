/**
 * SSDP discovery for HEOS capable devices.
 *
 * HEOS speakers answer an M-SEARCH for the Denon ACT search target. Any single
 * device on the network is enough: the CLI on that device proxies the whole
 * system, so the first responder is used as the gateway.
 */

import dgram from 'node:dgram';
import http from 'node:http';

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
export const HEOS_SEARCH_TARGET = 'urn:schemas-denon-com:device:ACT-Denon:1';

function searchMessage(target) {
  return [
    'M-SEARCH * HTTP/1.1',
    `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
    'MAN: "ssdp:discover"',
    'MX: 3',
    `ST: ${target}`,
    '',
    '',
  ].join('\r\n');
}

function parseHeaders(text) {
  const headers = {};
  for (const line of text.split('\r\n').slice(1)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return headers;
}

/**
 * Fetch the UPnP device description to get a friendly name. Best effort only —
 * discovery still succeeds if the description is unreachable.
 */
function fetchFriendlyName(location, timeout = 2000) {
  return new Promise((resolve) => {
    const request = http.get(location, { timeout }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 64_000) request.destroy();
      });
      res.on('end', () => resolve(/<friendlyName>([^<]+)<\/friendlyName>/i.exec(body)?.[1] ?? null));
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

/**
 * Broadcast an M-SEARCH and collect the devices that answer.
 *
 * @param {object} [options]
 * @param {number} [options.timeout] how long to listen, in ms
 * @param {boolean} [options.resolveNames] look up UPnP friendly names
 * @returns {Promise<Array<{host: string, location: string, name: string | null, usn: string | undefined}>>}
 */
export function discoverDevices({ timeout = 5000, resolveNames = true } = {}) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    /** @type {Map<string, {host: string, location: string, name: string | null, usn?: string}>} */
    const found = new Map();
    let settled = false;

    /** Pending re-send timers, cleared on finish so none outlive the socket. */
    const sendTimers = [];
    // Declared up front: `finish` clears this and can run from the error
    // handler, which must not depend on the timeout having been created yet.
    let timer = null;

    const finish = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const handle of sendTimers) clearTimeout(handle);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      const devices = [...found.values()];
      if (resolveNames) {
        await Promise.all(
          devices.map(async (device) => {
            device.name = await fetchFriendlyName(device.location);
          }),
        );
      }
      resolve(devices);
    };

    socket.on('error', () => finish());

    socket.on('message', (buffer, rinfo) => {
      const text = buffer.toString('utf8');
      if (!text.startsWith('HTTP/1.1 200')) return;
      const headers = parseHeaders(text);
      if (headers.st && !headers.st.includes('ACT-Denon')) return;
      if (found.has(rinfo.address)) return;
      found.set(rinfo.address, {
        host: rinfo.address,
        location: headers.location ?? `http://${rinfo.address}:60006/upnp/desc/aios_device/aios_device.xml`,
        usn: headers.usn,
        name: null,
      });
    });

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
        socket.setMulticastTTL(4);
      } catch {
        /* not fatal on every platform */
      }
      const message = Buffer.from(searchMessage(HEOS_SEARCH_TARGET));
      // Devices occasionally miss the first datagram, so send a few.
      const send = () => {
        if (settled) return;
        try {
          socket.send(message, 0, message.length, SSDP_PORT, SSDP_ADDRESS, () => {});
        } catch {
          /* the socket closed underneath us; the timeout will resolve */
        }
      };
      send();
      for (const delay of [500, 1500]) {
        const handle = setTimeout(send, delay);
        handle.unref?.();
        sendTimers.push(handle);
      }
    });

    timer = setTimeout(finish, timeout);
    timer.unref?.();
  });
}

/** Convenience wrapper returning the first responder, or `null`. */
export async function discoverFirstDevice(options) {
  const [device] = await discoverDevices(options);
  return device ?? null;
}
