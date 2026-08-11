/**
 * REST surface consumed by the browser client.
 *
 * Every route is a thin adapter over {@link HeosClient}; the interesting logic
 * lives in the protocol layer. Errors carry the HEOS error id where there is
 * one so the UI can show the device's own wording.
 */

import { Router } from 'express';
import { manager } from '../heos/manager.js';
import { renderArt } from './art.js';
import { ADD_CRITERIA, SOURCE_IDS } from '../heos/protocol.js';

const asInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

/**
 * Parse a `:pid` route parameter, rejecting anything that is not a player id.
 * Without this a request like `/api/players/oops` reaches the device as a
 * command with no pid and comes back as the speaker's own opaque error.
 */
const requirePid = (value) => {
  const pid = Number.parseInt(value, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    const error = new Error(`Invalid player id: ${value}`);
    error.statusCode = 400;
    throw error;
  }
  return pid;
};

/** Wrap an async handler so rejections reach the error middleware. */
const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

export function createApiRouter() {
  const router = Router();

  // ------------------------------------------------------------ system

  router.get('/status', (req, res) => {
    res.json(manager.status);
  });

  router.post('/discover', route(async (req, res) => {
    const devices = await manager.rediscover();
    res.json({ devices });
  }));

  router.post('/connect', route(async (req, res) => {
    const { host, port } = req.body ?? {};
    if (!host) {
      res.status(400).json({ error: 'A host is required' });
      return;
    }
    const status = await manager.connectTo(host, { port: asInt(port, undefined), mode: 'device' });
    res.json(status);
  }));

  router.post('/account/sign-in', route(async (req, res) => {
    const { username, password } = req.body ?? {};
    if (!username || !password) {
      res.status(400).json({ error: 'A username and password are required' });
      return;
    }
    const user = await manager.require().signIn(username, password);
    res.json({ account: user });
  }));

  router.post('/account/sign-out', route(async (req, res) => {
    await manager.require().signOut();
    res.json({ account: null });
  }));

  // ------------------------------------------------------------ players

  router.get('/players', route(async (req, res) => {
    const client = manager.require();
    const [players, groups] = await Promise.all([client.getPlayers(), client.getGroups()]);
    const states = await Promise.all(
      players.map((player) =>
        client.getPlayerState(player.pid).catch(() => ({ pid: player.pid, state: 'stop', volume: 0, muted: false })),
      ),
    );
    const byPid = new Map(states.map((state) => [state.pid, state]));
    res.json({
      players: players.map((player) => ({ ...player, ...(byPid.get(player.pid) ?? {}) })),
      groups,
    });
  }));

  router.get('/players/:pid', route(async (req, res) => {
    res.json(await manager.require().getPlayerState(requirePid(req.params.pid)));
  }));

  router.post('/players/:pid/state', route(async (req, res) => {
    const pid = requirePid(req.params.pid);
    const { state } = req.body ?? {};
    await manager.require().setPlayState(pid, state);
    res.json({ pid, state });
  }));

  router.post('/players/:pid/next', route(async (req, res) => {
    await manager.require().next(requirePid(req.params.pid));
    res.json({ ok: true });
  }));

  router.post('/players/:pid/previous', route(async (req, res) => {
    await manager.require().previous(requirePid(req.params.pid));
    res.json({ ok: true });
  }));

  router.post('/players/:pid/volume', route(async (req, res) => {
    const pid = requirePid(req.params.pid);
    const level = await manager.require().setVolume(pid, Number(req.body?.level));
    res.json({ pid, level });
  }));

  router.post('/players/:pid/mute', route(async (req, res) => {
    const pid = requirePid(req.params.pid);
    const muted = Boolean(req.body?.muted);
    await manager.require().setMute(pid, muted);
    res.json({ pid, muted });
  }));

  router.post('/players/:pid/play-mode', route(async (req, res) => {
    const pid = requirePid(req.params.pid);
    const { repeat, shuffle } = req.body ?? {};
    await manager.require().setPlayMode(pid, { repeat, shuffle });
    res.json({ pid, repeat, shuffle });
  }));

  router.post('/groups', route(async (req, res) => {
    const pids = (req.body?.pids ?? []).map(Number).filter(Boolean);
    if (!pids.length) {
      res.status(400).json({ error: 'At least one player id is required' });
      return;
    }
    const result = await manager.require().setGroup(pids);
    res.json(result);
  }));

  // -------------------------------------------------------------- queue

  router.get('/players/:pid/queue', route(async (req, res) => {
    const queue = await manager.require().getQueue(requirePid(req.params.pid), {
      start: asInt(req.query.start, 0),
      count: asInt(req.query.count, 200),
    });
    res.json(queue);
  }));

  router.post('/players/:pid/queue/play', route(async (req, res) => {
    await manager.require().playQueueItem(requirePid(req.params.pid), asInt(req.body?.qid));
    res.json({ ok: true });
  }));

  router.post('/players/:pid/queue/remove', route(async (req, res) => {
    const qids = (req.body?.qids ?? []).map(Number).filter((qid) => Number.isFinite(qid));
    if (!qids.length) {
      res.status(400).json({ error: 'At least one queue id is required' });
      return;
    }
    await manager.require().removeFromQueue(requirePid(req.params.pid), qids);
    res.json({ ok: true });
  }));

  router.post('/players/:pid/queue/move', route(async (req, res) => {
    await manager.require().moveQueueItem(requirePid(req.params.pid), asInt(req.body?.from), asInt(req.body?.to));
    res.json({ ok: true });
  }));

  router.delete('/players/:pid/queue', route(async (req, res) => {
    await manager.require().clearQueue(requirePid(req.params.pid));
    res.json({ ok: true });
  }));

  router.post('/players/:pid/queue/save', route(async (req, res) => {
    await manager.require().saveQueue(requirePid(req.params.pid), req.body?.name);
    res.json({ ok: true });
  }));

  // ------------------------------------------------------------- browse

  router.get('/sources', route(async (req, res) => {
    const sources = await manager.require().getMusicSources({ refresh: req.query.refresh === 'true' });
    res.json({ sources });
  }));

  router.get('/browse', route(async (req, res) => {
    const { sid, cid } = req.query;
    if (!sid) {
      res.status(400).json({ error: 'sid is required' });
      return;
    }
    const result = await manager.require().browse({
      sid,
      cid: cid || undefined,
      start: asInt(req.query.start, 0),
      count: asInt(req.query.count, 100),
    });
    res.json(result);
  }));

  router.get('/search-criteria', route(async (req, res) => {
    const criteria = await manager.require().getSearchCriteria(req.query.sid);
    res.json({ criteria });
  }));

  router.get('/search', route(async (req, res) => {
    const { sid, q, scid } = req.query;
    if (!sid || !q) {
      res.status(400).json({ error: 'sid and q are required' });
      return;
    }
    const result = await manager.require().search({
      sid,
      query: q,
      scid: scid || undefined,
      start: asInt(req.query.start, 0),
      count: asInt(req.query.count, 50),
    });
    res.json(result);
  }));

  /** The action-sheet endpoint: Play Now / Play Next / Add to End / Replace. */
  router.post('/play', route(async (req, res) => {
    const { pid, sid, cid, mid, action = 'PLAY_NOW', name, isStation, input } = req.body ?? {};
    if (!pid) {
      res.status(400).json({ error: 'pid is required' });
      return;
    }
    const client = manager.require();

    if (input) {
      await client.playInput({ pid, input, sourcePid: cid || undefined });
      res.json({ ok: true, played: 'input' });
      return;
    }

    const aid = ADD_CRITERIA[action];
    if (!aid) {
      res.status(400).json({ error: `Unknown action ${action}` });
      return;
    }
    const result = await client.addToQueue({ pid, sid, cid, mid, aid, name, isStation });
    res.json({ ok: true, ...result });
  }));

  router.post('/play-url', route(async (req, res) => {
    const { pid, url } = req.body ?? {};
    if (!pid || !url) {
      res.status(400).json({ error: 'pid and url are required' });
      return;
    }
    await manager.require().playUrl(pid, url);
    res.json({ ok: true });
  }));

  router.post('/favorites', route(async (req, res) => {
    const { pid, sid, mid, name } = req.body ?? {};
    const payload = await manager.require().addToFavorites({ pid, sid, mid, name });
    res.json({ ok: true, payload });
  }));

  router.delete('/favorites/:mid', route(async (req, res) => {
    await manager.require().removeFromFavorites(req.params.mid);
    res.json({ ok: true });
  }));

  router.post('/playlists/rename', route(async (req, res) => {
    const { sid = SOURCE_IDS.PLAYLISTS, cid, name } = req.body ?? {};
    await manager.require().renamePlaylist({ sid, cid, name });
    res.json({ ok: true });
  }));

  router.delete('/playlists/:cid', route(async (req, res) => {
    await manager.require().deletePlaylist({ sid: req.query.sid ?? SOURCE_IDS.PLAYLISTS, cid: req.params.cid });
    res.json({ ok: true });
  }));

  // ----------------------------------------------------------- artwork

  router.get('/art/:seed', (req, res) => {
    const seed = req.params.seed.replace(/\.svg$/i, '');
    res.type('image/svg+xml');
    res.set('Cache-Control', 'public, max-age=86400, immutable');
    res.send(renderArt(seed, asInt(req.query.size, 512)));
  });

  return router;
}

/** Express error middleware translating HEOS failures into JSON responses. */
export function apiErrorHandler(err, req, res, next) {
  if (res.headersSent) {
    next(err);
    return;
  }
  const status = err.statusCode ?? (err.eid ? 400 : 500);
  res.status(status).json({
    error: err.message || 'Unexpected error',
    eid: err.eid,
    command: err.command,
  });
}
