/** Entry point: serves the web UI, the REST API and the event WebSocket. */

import http from 'node:http';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { config } from './config.js';
import { manager } from './heos/manager.js';
import { createApiRouter, apiErrorHandler } from './api/routes.js';
import { attachWebSocket } from './ws/hub.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use('/api', createApiRouter());
  app.use('/api', (req, res) => res.status(404).json({ error: `No such endpoint: ${req.method} ${req.originalUrl}` }));
  app.use(express.static(publicDir, { extensions: ['html'] }));
  // Single page app: anything unmatched renders the shell.
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  app.use(apiErrorHandler);
  return app;
}

export async function start() {
  const app = createApp();
  const server = http.createServer(app);
  attachWebSocket(server);

  manager.on('log', (message) => console.log(`[heos] ${message}`));

  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  console.log(`[heos] Web UI listening on http://localhost:${config.port}`);

  manager
    .init()
    .then((status) => {
      if (status.connected) {
        console.log(`[heos] Connected to ${status.deviceName ?? status.host} (${status.mode})`);
      } else {
        console.warn(`[heos] Not connected: ${status.error ?? 'unknown reason'}`);
      }
    })
    .catch((err) => console.error('[heos] Startup failed:', err));

  const shutdown = async () => {
    console.log('\n[heos] Shutting down…');
    await manager.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}

/**
 * True when this module is the process entry point.
 *
 * Both sides are reduced to a real filesystem path before comparing:
 * `import.meta.url` is percent-encoded and symlink-resolved while
 * `process.argv[1]` is neither, so string-comparing them silently fails for
 * checkouts under a path containing a space or non-ASCII character, behind a
 * symlink, or on Windows — and the server would then start nothing at all.
 */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  const real = (target) => {
    try {
      return realpathSync(target);
    } catch {
      return path.resolve(target);
    }
  };
  return real(fileURLToPath(import.meta.url)) === real(process.argv[1]);
}

if (isEntryPoint()) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
