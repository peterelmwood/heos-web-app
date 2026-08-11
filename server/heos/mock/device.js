/**
 * An in-process HEOS device simulator.
 *
 * It is a real TCP server speaking the real CLI protocol, so the rest of the
 * stack (connection, client, REST API, browser) is byte-for-byte identical
 * whether it is talking to this or to a speaker on the LAN. That makes the
 * demo mode useful for development and for the test suite.
 */

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { parseCommand, stringifyAttributes, SOURCE_IDS } from '../protocol.js';
import {
  art,
  findStation,
  findTrack,
  initialFavorites,
  initialHistory,
  inputs,
  library,
  players as playerSeeds,
  playlists,
  sources,
  stationGroups,
  stations,
} from './catalog.js';

const TICK_MS = 1000;

class HeosError extends Error {
  constructor(eid, text) {
    super(text);
    this.eid = eid;
    this.text = text;
  }
}

const INVALID_ID = (text = 'Invalid ID') => new HeosError(6, text);
const UNSUPPORTED = (text = 'Command not supported') => new HeosError(4, text);

function parseRange(range, fallbackCount = 100) {
  if (!range) return { start: 0, end: fallbackCount - 1 };
  const [start, end] = range.split(',').map((value) => Number.parseInt(value, 10));
  if (Number.isNaN(start)) return { start: 0, end: fallbackCount - 1 };
  return { start, end: Number.isNaN(end) ? start + fallbackCount - 1 : end };
}

function slice(items, range) {
  const { start, end } = parseRange(range, items.length || 1);
  return items.slice(start, end + 1);
}

const trackToQueueItem = (track, qid) => ({
  qid: String(qid),
  mid: track.mid,
  song: track.title,
  album: track.album,
  artist: track.artist,
  image_url: track.image,
  album_id: track.albumId,
});

const containerItem = ({ name, cid, image, type = 'container', playable = 'yes' }) => ({
  container: 'yes',
  playable,
  type,
  name,
  image_url: image ?? art(name),
  cid,
});

const trackItem = (track) => ({
  container: 'no',
  playable: 'yes',
  type: 'song',
  name: track.title,
  image_url: track.image,
  mid: track.mid,
  artist: track.artist,
  album: track.album,
  album_id: track.albumId,
});

const stationItem = (station) => ({
  container: 'no',
  playable: 'yes',
  type: 'station',
  name: station.name,
  image_url: station.image,
  mid: station.mid,
  artist: station.description,
});

export class MockHeosDevice extends EventEmitter {
  constructor({ host = '127.0.0.1', port = 0 } = {}) {
    super();
    this.host = host;
    this.requestedPort = port;
    this.server = null;
    /** @type {Set<net.Socket & {heosRegistered?: boolean}>} */
    this.sockets = new Set();
    this.signedInUser = 'demo@heos.local';
    this.favorites = [...initialFavorites];
    this.history = [...initialHistory];
    this.nextQid = 1;
    this.nextGid = 1;
    this.groups = new Map();
    this.players = new Map(
      playerSeeds.map((seed) => [
        seed.pid,
        {
          info: { ...seed },
          state: 'stop',
          volume: 22 + (seed.pid % 7) * 3,
          mute: false,
          repeat: 'off',
          shuffle: false,
          queue: [],
          currentQid: null,
          station: null,
          position: 0,
          duration: 0,
        },
      ]),
    );
    this.tick = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this.#handleSocket(socket));
      this.server.once('error', reject);
      this.server.listen(this.requestedPort, this.host, () => {
        this.port = this.server.address().port;
        this.tick = setInterval(() => this.#advancePlayback(), TICK_MS);
        this.tick.unref?.();
        resolve({ host: this.host, port: this.port });
      });
    });
  }

  async stop() {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
  }

  #handleSocket(socket) {
    socket.setEncoding('utf8');
    this.sockets.add(socket);
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (line.trim()) this.#dispatch(socket, line);
      }
    });
    socket.on('error', () => this.sockets.delete(socket));
    socket.on('close', () => this.sockets.delete(socket));
  }

  #dispatch(socket, line) {
    let path = '';
    let attrs = {};
    try {
      ({ path, attrs } = parseCommand(line));
    } catch {
      this.#write(socket, { command: 'system/unknown', result: 'fail', message: 'eid=2&text=Invalid Command' });
      return;
    }

    try {
      const result = this.#execute(path, attrs, socket) ?? {};
      this.#write(socket, {
        command: path,
        result: 'success',
        message: stringifyAttributes(result.message ?? attrs),
        payload: result.payload,
        options: result.options,
      });
    } catch (err) {
      const eid = err instanceof HeosError ? err.eid : 9;
      const text = err instanceof HeosError ? err.text : 'Internal error';
      this.#write(socket, {
        command: path,
        result: 'fail',
        message: `eid=${eid}&text=${encodeURIComponent(text)}`,
      });
    }
  }

  #write(socket, { command, result, message, payload, options }) {
    const envelope = { heos: { command, result, message } };
    if (payload !== undefined) envelope.payload = payload;
    if (options !== undefined) envelope.options = options;
    socket.write(`${JSON.stringify(envelope)}\r\n`);
  }

  #broadcast(command, attrs) {
    const line = `${JSON.stringify({ heos: { command: `event/${command}`, message: stringifyAttributes(attrs) } })}\r\n`;
    for (const socket of this.sockets) {
      if (socket.heosRegistered && socket.writable) socket.write(line);
    }
  }

  #player(pid) {
    const player = this.players.get(Number(pid));
    if (!player) throw INVALID_ID(`Unknown player ${pid}`);
    return player;
  }

  // ------------------------------------------------------------- dispatcher

  #execute(path, attrs, socket) {
    const [group, command] = path.split('/');
    switch (group) {
      case 'system':
        return this.#system(command, attrs, socket);
      case 'player':
        return this.#playerCommand(command, attrs);
      case 'group':
        return this.#groupCommand(command, attrs);
      case 'browse':
        return this.#browseCommand(command, attrs);
      default:
        throw UNSUPPORTED(`Unknown command group ${group}`);
    }
  }

  #system(command, attrs, socket) {
    switch (command) {
      case 'register_for_change_events':
        socket.heosRegistered = attrs.enable === 'on';
        return { message: { enable: attrs.enable } };
      case 'heart_beat':
      case 'prettify_json_response':
        return {};
      case 'check_account':
        return {
          message: this.signedInUser
            ? { signed_in: '', un: this.signedInUser }
            : { signed_out: '' },
        };
      case 'sign_in':
        if (!attrs.un || !attrs.pw) throw new HeosError(10, 'User not logged in');
        this.signedInUser = attrs.un;
        this.#broadcast('user_changed', { signed_in: '', un: this.signedInUser });
        return { message: { signed_in: '', un: this.signedInUser } };
      case 'sign_out':
        this.signedInUser = null;
        this.#broadcast('user_changed', { signed_out: '' });
        return { message: { signed_out: '' } };
      default:
        throw UNSUPPORTED();
    }
  }

  // ---------------------------------------------------------------- players

  #playerCommand(command, attrs) {
    switch (command) {
      case 'get_players':
        return { message: {}, payload: [...this.players.values()].map((player) => ({ ...player.info })) };
      case 'get_player_info':
        return { message: { pid: attrs.pid }, payload: { ...this.#player(attrs.pid).info } };
      case 'get_play_state':
        return { message: { pid: attrs.pid, state: this.#player(attrs.pid).state } };
      case 'set_play_state':
        return this.#setPlayState(attrs);
      case 'get_now_playing_media':
        return { message: { pid: attrs.pid }, payload: this.#nowPlayingPayload(attrs.pid) };
      case 'get_volume':
        return { message: { pid: attrs.pid, level: this.#player(attrs.pid).volume } };
      case 'set_volume':
        return this.#setVolume(attrs.pid, Number(attrs.level));
      case 'volume_up':
        return this.#setVolume(attrs.pid, this.#player(attrs.pid).volume + Number(attrs.step || 5));
      case 'volume_down':
        return this.#setVolume(attrs.pid, this.#player(attrs.pid).volume - Number(attrs.step || 5));
      case 'get_mute':
        return { message: { pid: attrs.pid, state: this.#player(attrs.pid).mute ? 'on' : 'off' } };
      case 'set_mute':
        return this.#setMute(attrs.pid, attrs.state === 'on');
      case 'toggle_mute':
        return this.#setMute(attrs.pid, !this.#player(attrs.pid).mute);
      case 'get_play_mode': {
        const player = this.#player(attrs.pid);
        return { message: { pid: attrs.pid, repeat: player.repeat, shuffle: player.shuffle ? 'on' : 'off' } };
      }
      case 'set_play_mode':
        return this.#setPlayMode(attrs);
      case 'play_next':
        return this.#skip(attrs.pid, 1);
      case 'play_previous':
        return this.#skip(attrs.pid, -1);
      case 'get_queue': {
        const player = this.#player(attrs.pid);
        const items = slice(player.queue, attrs.range);
        return {
          message: { pid: attrs.pid, range: attrs.range ?? '', returned: items.length, count: player.queue.length },
          payload: items,
        };
      }
      case 'play_queue':
        return this.#playQueueItem(attrs.pid, attrs.qid);
      case 'remove_from_queue':
        return this.#removeFromQueue(attrs.pid, String(attrs.qid ?? '').split(','));
      case 'clear_queue': {
        const player = this.#player(attrs.pid);
        player.queue = [];
        player.currentQid = null;
        player.state = 'stop';
        player.position = 0;
        this.#broadcast('player_queue_changed', { pid: attrs.pid });
        this.#broadcast('player_state_changed', { pid: attrs.pid, state: 'stop' });
        this.#broadcast('player_now_playing_changed', { pid: attrs.pid });
        return { message: { pid: attrs.pid } };
      }
      case 'move_queue_item':
        return this.#moveQueueItem(attrs);
      case 'save_queue':
        return { message: { pid: attrs.pid, name: attrs.name } };
      default:
        throw UNSUPPORTED();
    }
  }

  #setPlayState({ pid, state }) {
    const player = this.#player(pid);
    if (!['play', 'pause', 'stop'].includes(state)) throw INVALID_ID('Invalid play state');
    if (state === 'play' && !player.currentQid && !player.station && player.queue.length) {
      player.currentQid = player.queue[0].qid;
      player.position = 0;
      this.#emitNowPlaying(pid);
    }
    player.state = state;
    if (state === 'stop') player.position = 0;
    this.#broadcast('player_state_changed', { pid, state });
    return { message: { pid, state } };
  }

  #setVolume(pid, level) {
    const player = this.#player(pid);
    player.volume = Math.max(0, Math.min(100, Math.round(level)));
    this.#broadcast('player_volume_changed', { pid, level: player.volume, mute: player.mute ? 'on' : 'off' });
    return { message: { pid, level: player.volume } };
  }

  #setMute(pid, muted) {
    const player = this.#player(pid);
    player.mute = muted;
    this.#broadcast('player_volume_changed', { pid, level: player.volume, mute: muted ? 'on' : 'off' });
    return { message: { pid, state: muted ? 'on' : 'off' } };
  }

  #setPlayMode({ pid, repeat, shuffle }) {
    const player = this.#player(pid);
    if (repeat) player.repeat = repeat;
    if (shuffle) player.shuffle = shuffle === 'on';
    this.#broadcast('repeat_mode_changed', { pid, repeat: player.repeat });
    this.#broadcast('shuffle_mode_changed', { pid, shuffle: player.shuffle ? 'on' : 'off' });
    return { message: { pid, repeat: player.repeat, shuffle: player.shuffle ? 'on' : 'off' } };
  }

  #currentIndex(player) {
    return player.queue.findIndex((item) => item.qid === String(player.currentQid));
  }

  #skip(pid, delta) {
    const player = this.#player(pid);
    if (player.station) {
      // Radio has nothing to skip to.
      return { message: { pid } };
    }
    const index = this.#currentIndex(player);
    if (index === -1 || !player.queue.length) return { message: { pid } };
    let next = index + delta;
    if (player.shuffle && player.queue.length > 1) {
      // Deterministic pseudo-shuffle: step by a coprime stride.
      next = (index + 3) % player.queue.length;
    }
    if (next < 0) next = player.repeat === 'on_all' ? player.queue.length - 1 : 0;
    if (next >= player.queue.length) {
      if (player.repeat === 'on_all') next = 0;
      else {
        player.state = 'stop';
        player.position = 0;
        this.#broadcast('player_state_changed', { pid, state: 'stop' });
        return { message: { pid } };
      }
    }
    player.currentQid = player.queue[next].qid;
    player.position = 0;
    player.state = 'play';
    this.#emitNowPlaying(pid);
    this.#broadcast('player_state_changed', { pid, state: 'play' });
    return { message: { pid } };
  }

  #playQueueItem(pid, qid) {
    const player = this.#player(pid);
    const item = player.queue.find((entry) => entry.qid === String(qid));
    if (!item) throw INVALID_ID(`Unknown queue id ${qid}`);
    player.station = null;
    player.currentQid = item.qid;
    player.position = 0;
    player.state = 'play';
    this.#emitNowPlaying(pid);
    this.#broadcast('player_state_changed', { pid, state: 'play' });
    return { message: { pid, qid } };
  }

  #removeFromQueue(pid, qids) {
    const player = this.#player(pid);
    const removing = new Set(qids.map(String));
    const wasCurrent = removing.has(String(player.currentQid));
    player.queue = player.queue.filter((item) => !removing.has(item.qid));
    if (wasCurrent) {
      player.currentQid = player.queue[0]?.qid ?? null;
      player.position = 0;
      if (!player.currentQid) player.state = 'stop';
      this.#emitNowPlaying(pid);
    }
    this.#broadcast('player_queue_changed', { pid });
    return { message: { pid, qid: qids.join(',') } };
  }

  #moveQueueItem({ pid, sqid, dqid }) {
    const player = this.#player(pid);
    const from = player.queue.findIndex((item) => item.qid === String(sqid));
    const to = player.queue.findIndex((item) => item.qid === String(dqid));
    if (from === -1 || to === -1) throw INVALID_ID('Unknown queue id');
    const [moved] = player.queue.splice(from, 1);
    player.queue.splice(to, 0, moved);
    this.#broadcast('player_queue_changed', { pid });
    return { message: { pid, sqid, dqid } };
  }

  #nowPlayingPayload(pid) {
    const player = this.#player(pid);
    if (player.station) {
      const station = player.station;
      return {
        type: 'station',
        song: station.description ?? '',
        station: station.name,
        album: '',
        artist: station.name,
        image_url: station.image,
        mid: station.mid,
        qid: '',
        sid: String(SOURCE_IDS.TUNEIN),
      };
    }
    const item = player.queue.find((entry) => entry.qid === String(player.currentQid));
    if (!item) return { type: 'station', song: '', station: '', album: '', artist: '', image_url: '', mid: '', qid: '', sid: '' };
    return {
      type: 'song',
      song: item.song,
      album: item.album,
      artist: item.artist,
      image_url: item.image_url,
      album_id: item.album_id,
      mid: item.mid,
      qid: item.qid,
      sid: String(SOURCE_IDS.LOCAL_MUSIC),
    };
  }

  #emitNowPlaying(pid) {
    const player = this.#player(pid);
    const track = player.station ? null : findTrack(player.queue.find((i) => i.qid === String(player.currentQid))?.mid);
    player.duration = player.station ? 0 : track?.duration ?? 0;
    this.#recordHistory(player.station ? player.station.mid : track?.mid);
    this.#broadcast('player_now_playing_changed', { pid });
  }

  #recordHistory(mid) {
    if (!mid) return;
    this.history = [mid, ...this.history.filter((entry) => entry !== mid)].slice(0, 30);
  }

  #advancePlayback() {
    for (const [pid, player] of this.players) {
      if (player.state !== 'play') continue;
      if (player.station) {
        player.position += TICK_MS;
        this.#broadcast('player_now_playing_progress', { pid, cur_pos: player.position, duration: 0 });
        continue;
      }
      if (!player.duration) {
        const track = findTrack(player.queue.find((i) => i.qid === String(player.currentQid))?.mid);
        player.duration = track?.duration ?? 0;
      }
      player.position += TICK_MS;
      if (player.duration && player.position >= player.duration) {
        if (player.repeat === 'on_one') {
          player.position = 0;
          this.#emitNowPlaying(pid);
        } else {
          this.#skip(pid, 1);
        }
        continue;
      }
      this.#broadcast('player_now_playing_progress', { pid, cur_pos: player.position, duration: player.duration });
    }
  }

  // ----------------------------------------------------------------- groups

  #groupCommand(command, attrs) {
    switch (command) {
      case 'get_groups':
        return { message: {}, payload: [...this.groups.values()] };
      case 'get_group_info': {
        const group = this.groups.get(Number(attrs.gid));
        if (!group) throw INVALID_ID(`Unknown group ${attrs.gid}`);
        return { message: { gid: attrs.gid }, payload: group };
      }
      case 'set_group':
        return this.#setGroup(attrs);
      case 'get_volume': {
        const group = this.groups.get(Number(attrs.gid));
        if (!group) throw INVALID_ID(`Unknown group ${attrs.gid}`);
        const levels = group.players.map((member) => this.#player(member.pid).volume);
        return { message: { gid: attrs.gid, level: Math.round(levels.reduce((a, b) => a + b, 0) / levels.length) } };
      }
      case 'set_volume': {
        const group = this.groups.get(Number(attrs.gid));
        if (!group) throw INVALID_ID(`Unknown group ${attrs.gid}`);
        for (const member of group.players) this.#setVolume(member.pid, Number(attrs.level));
        this.#broadcast('group_volume_changed', { gid: attrs.gid, level: attrs.level, mute: 'off' });
        return { message: { gid: attrs.gid, level: attrs.level } };
      }
      default:
        throw UNSUPPORTED();
    }
  }

  #setGroup({ pid }) {
    const pids = String(pid).split(',').map((value) => Number(value.trim())).filter(Boolean);
    if (!pids.length) throw INVALID_ID('No players supplied');
    const leaderPid = pids[0];
    const leader = this.#player(leaderPid);

    // Drop every supplied player out of whatever group it is in today.
    for (const [gid, group] of [...this.groups]) {
      const remaining = group.players.filter((member) => !pids.includes(member.pid));
      if (remaining.length === group.players.length) continue;
      if (remaining.length <= 1) {
        for (const member of group.players) this.#player(member.pid).info.gid = undefined;
        this.groups.delete(gid);
      } else {
        group.players = remaining;
      }
    }

    if (pids.length === 1) {
      leader.info.gid = undefined;
      this.#broadcast('groups_changed', {});
      return { message: { pid: String(leaderPid) } };
    }

    const gid = leaderPid; // HEOS reuses the leader's pid as the group id.
    const group = {
      gid,
      name: pids.map((memberPid) => this.#player(memberPid).info.name).join(' + '),
      players: pids.map((memberPid, index) => ({
        pid: memberPid,
        name: this.#player(memberPid).info.name,
        role: index === 0 ? 'leader' : 'member',
      })),
    };
    this.groups.set(gid, group);
    for (const memberPid of pids) this.#player(memberPid).info.gid = gid;
    this.#broadcast('groups_changed', {});
    return { message: { gid: String(gid), name: group.name, pid: pids.join(',') } };
  }

  // ----------------------------------------------------------------- browse

  #browseCommand(command, attrs) {
    switch (command) {
      case 'get_music_sources':
        return { message: {}, payload: sources.map((source) => ({ ...source, sid: String(source.sid) })) };
      case 'get_source_info': {
        const source = sources.find((entry) => entry.sid === Number(attrs.sid));
        if (!source) throw INVALID_ID(`Unknown source ${attrs.sid}`);
        return { message: { sid: attrs.sid }, payload: { ...source, sid: String(source.sid) } };
      }
      case 'browse':
        return this.#browse(attrs);
      case 'search':
        return this.#search(attrs);
      case 'get_search_criteria':
        return this.#searchCriteria(attrs);
      case 'add_to_queue':
        return this.#addToQueue(attrs);
      case 'play_stream':
        return this.#playStream(attrs);
      case 'play_input':
        return this.#playInput(attrs);
      case 'set_service_option':
        return this.#serviceOption(attrs);
      case 'rename_playlist': {
        const playlist = playlists.find((entry) => entry.cid === attrs.cid);
        if (!playlist) throw INVALID_ID('Unknown playlist');
        playlist.name = attrs.name;
        this.#broadcast('sources_changed', {});
        return { message: { sid: attrs.sid, cid: attrs.cid, name: attrs.name } };
      }
      case 'delete_playlist': {
        const index = playlists.findIndex((entry) => entry.cid === attrs.cid);
        if (index === -1) throw INVALID_ID('Unknown playlist');
        playlists.splice(index, 1);
        this.#broadcast('sources_changed', {});
        return { message: { sid: attrs.sid, cid: attrs.cid } };
      }
      default:
        throw UNSUPPORTED();
    }
  }

  #browseResult(attrs, items, options) {
    const windowed = slice(items, attrs.range);
    return {
      message: {
        sid: attrs.sid,
        ...(attrs.cid ? { cid: attrs.cid } : {}),
        returned: windowed.length,
        count: items.length,
      },
      payload: windowed,
      options,
    };
  }

  #browse(attrs) {
    const sid = Number(attrs.sid);
    const cid = attrs.cid;
    switch (sid) {
      case SOURCE_IDS.LOCAL_MUSIC:
      case SOURCE_IDS.AMAZON:
        return this.#browseResult(attrs, this.#browseLibrary(sid, cid), this.#browseOptions(sid, cid));
      case SOURCE_IDS.PLAYLISTS:
        return this.#browseResult(attrs, this.#browsePlaylists(cid));
      case SOURCE_IDS.HISTORY:
        return this.#browseResult(attrs, this.#browseHistory());
      case SOURCE_IDS.FAVORITES:
        return this.#browseResult(
          attrs,
          this.favorites.map((mid) => stationItem(findStation(mid))).filter(Boolean),
          [{ browse: [{ id: '20', name: 'Remove from HEOS Favorites' }] }],
        );
      case SOURCE_IDS.AUX_INPUT:
        return this.#browseResult(attrs, this.#browseInputs(cid));
      case SOURCE_IDS.TUNEIN:
        return this.#browseResult(attrs, this.#browseTuneIn(cid), [
          { browse: [{ id: '19', name: 'Add to HEOS Favorites' }] },
        ]);
      default:
        throw INVALID_ID(`Source ${attrs.sid} is not available`);
    }
  }

  #browseOptions(sid, cid) {
    if (cid) return undefined;
    return [{ browse: [{ id: '19', name: 'Add to HEOS Favorites' }] }];
  }

  #browseLibrary(sid, cid) {
    if (!cid) {
      const roots = [
        containerItem({ name: 'Artists', cid: 'artists', playable: 'no', image: art('Artists') }),
        containerItem({ name: 'Albums', cid: 'albums', playable: 'no', image: art('Albums') }),
        containerItem({ name: 'Genres', cid: 'genres', playable: 'no', image: art('Genres') }),
        containerItem({ name: 'Songs', cid: 'songs', playable: 'yes', image: art('Songs') }),
      ];
      if (sid === SOURCE_IDS.AMAZON) {
        roots.push(containerItem({ name: 'My Playlists', cid: 'playlists', playable: 'no', image: art('My Playlists') }));
      }
      return roots;
    }
    if (cid === 'artists') {
      return library.artists.map((artist) =>
        containerItem({ name: artist.name, cid: artist.cid, image: artist.image, type: 'artist' }),
      );
    }
    if (cid === 'albums') {
      return library.albums.map((album) => ({
        ...containerItem({ name: album.title, cid: album.cid, image: album.image, type: 'album' }),
        artist: album.artist,
      }));
    }
    if (cid === 'genres') {
      return library.genres.map((genre) =>
        containerItem({ name: genre.name, cid: genre.cid, image: genre.image, type: 'genre', playable: 'no' }),
      );
    }
    if (cid === 'songs') return library.tracks.map(trackItem);
    if (cid === 'playlists') {
      return playlists.map((playlist) =>
        containerItem({ name: playlist.name, cid: playlist.cid, image: playlist.image, type: 'playlist' }),
      );
    }
    if (cid.startsWith('artist:')) {
      const artist = library.artists.find((entry) => entry.cid === cid);
      if (!artist) throw INVALID_ID('Unknown artist');
      return artist.albums.map((album) => ({
        ...containerItem({ name: album.title, cid: album.cid, image: album.image, type: 'album' }),
        artist: album.artist,
      }));
    }
    if (cid.startsWith('genre:')) {
      const genre = library.genres.find((entry) => entry.cid === cid);
      if (!genre) throw INVALID_ID('Unknown genre');
      return genre.albums.map((album) => ({
        ...containerItem({ name: album.title, cid: album.cid, image: album.image, type: 'album' }),
        artist: album.artist,
      }));
    }
    if (cid.startsWith('album:')) {
      const album = library.albums.find((entry) => entry.cid === cid);
      if (!album) throw INVALID_ID('Unknown album');
      return album.tracks.map(trackItem);
    }
    if (cid.startsWith('playlist:')) return this.#browsePlaylists(cid);
    throw INVALID_ID(`Unknown container ${cid}`);
  }

  #browsePlaylists(cid) {
    if (!cid) {
      return playlists.map((playlist) =>
        containerItem({ name: playlist.name, cid: playlist.cid, image: playlist.image, type: 'playlist' }),
      );
    }
    const playlist = playlists.find((entry) => entry.cid === cid);
    if (!playlist) throw INVALID_ID('Unknown playlist');
    return playlist.tracks.map(trackItem);
  }

  #browseHistory() {
    return this.history
      .map((mid) => {
        const track = findTrack(mid);
        if (track) return trackItem(track);
        const station = findStation(mid);
        return station ? stationItem(station) : null;
      })
      .filter(Boolean);
  }

  #browseInputs(cid) {
    if (!cid) {
      return [...this.players.values()].map((player) =>
        containerItem({
          name: player.info.name,
          cid: `inputs:${player.info.pid}`,
          image: art(player.info.name),
          type: 'heos_server',
          playable: 'no',
        }),
      );
    }
    const pid = Number(cid.split(':')[1]);
    this.#player(pid);
    return inputs.map((input) => ({
      container: 'no',
      playable: 'yes',
      type: 'media_input',
      name: input.split('/')[1].replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      image_url: art(input),
      mid: input,
      sid: String(SOURCE_IDS.AUX_INPUT),
      cid: String(pid),
    }));
  }

  #browseTuneIn(cid) {
    if (!cid) {
      return stationGroups.map((name) =>
        containerItem({ name, cid: `tunein:${name}`, image: art(name), playable: 'no' }),
      );
    }
    const groupName = cid.slice('tunein:'.length);
    const matches = stations.filter((station) => station.group === groupName);
    if (!matches.length) throw INVALID_ID('Unknown container');
    return matches.map(stationItem);
  }

  #searchCriteria({ sid }) {
    const criteria =
      Number(sid) === SOURCE_IDS.TUNEIN
        ? [{ name: 'Station', scid: '4', wildcard: 'yes' }]
        : [
            { name: 'Artist', scid: '1', wildcard: 'yes' },
            { name: 'Album', scid: '2', wildcard: 'yes' },
            { name: 'Track', scid: '3', wildcard: 'yes' },
          ];
    return { message: { sid }, payload: criteria };
  }

  #search(attrs) {
    const sid = Number(attrs.sid);
    const query = String(attrs.search ?? '').trim().toLowerCase();
    const scid = Number(attrs.scid || 0);
    if (!query) throw INVALID_ID('Empty search');

    let items = [];
    if (sid === SOURCE_IDS.TUNEIN) {
      items = stations.filter((station) => station.name.toLowerCase().includes(query)).map(stationItem);
    } else {
      const matchArtists = library.artists
        .filter((artist) => artist.name.toLowerCase().includes(query))
        .map((artist) => containerItem({ name: artist.name, cid: artist.cid, image: artist.image, type: 'artist' }));
      const matchAlbums = library.albums
        .filter((album) => album.title.toLowerCase().includes(query))
        .map((album) => ({
          ...containerItem({ name: album.title, cid: album.cid, image: album.image, type: 'album' }),
          artist: album.artist,
        }));
      const matchTracks = library.tracks
        .filter((track) => track.title.toLowerCase().includes(query))
        .map(trackItem);
      if (scid === 1) items = matchArtists;
      else if (scid === 2) items = matchAlbums;
      else if (scid === 3) items = matchTracks;
      else items = [...matchArtists, ...matchAlbums, ...matchTracks];
    }

    const windowed = slice(items, attrs.range);
    return {
      message: {
        sid: attrs.sid,
        search: attrs.search,
        scid: attrs.scid ?? '',
        returned: windowed.length,
        count: items.length,
      },
      payload: windowed,
    };
  }

  /** Resolve a browse target (container or single item) into concrete tracks. */
  #resolveTracks({ sid, cid, mid }) {
    if (mid) {
      const track = findTrack(mid);
      if (track) return [track];
      return [];
    }
    if (!cid) return [];
    if (Number(sid) === SOURCE_IDS.PLAYLISTS || cid.startsWith('playlist:')) {
      return playlists.find((entry) => entry.cid === cid)?.tracks ?? [];
    }
    if (cid === 'songs') return library.tracks;
    if (cid === 'albums') return library.albums.flatMap((album) => album.tracks);
    if (cid === 'artists') return library.artists.flatMap((artist) => artist.albums.flatMap((album) => album.tracks));
    if (cid.startsWith('album:')) return library.albums.find((entry) => entry.cid === cid)?.tracks ?? [];
    if (cid.startsWith('artist:')) {
      return library.artists.find((entry) => entry.cid === cid)?.albums.flatMap((album) => album.tracks) ?? [];
    }
    if (cid.startsWith('genre:')) {
      return library.genres.find((entry) => entry.cid === cid)?.albums.flatMap((album) => album.tracks) ?? [];
    }
    return [];
  }

  #addToQueue(attrs) {
    const player = this.#player(attrs.pid);
    const aid = Number(attrs.aid || 1);
    const tracks = this.#resolveTracks(attrs);
    if (!tracks.length) throw INVALID_ID('Nothing to enqueue');

    const items = tracks.map((track) => trackToQueueItem(track, this.nextQid++));

    if (aid === 4) {
      player.queue = items;
      player.station = null;
      player.currentQid = items[0].qid;
      player.position = 0;
      player.state = 'play';
    } else if (aid === 1) {
      // Play Now drops the selection in right after whatever is playing.
      const index = this.#currentIndex(player);
      player.queue.splice(index === -1 ? 0 : index + 1, 0, ...items);
      player.station = null;
      player.currentQid = items[0].qid;
      player.position = 0;
      player.state = 'play';
    } else if (aid === 2) {
      const index = this.#currentIndex(player);
      player.queue.splice(index === -1 ? player.queue.length : index + 1, 0, ...items);
    } else {
      player.queue.push(...items);
    }

    if ((aid === 2 || aid === 3) && !player.currentQid) {
      player.currentQid = player.queue[0].qid;
      player.position = 0;
    }

    // Renumber qids so they stay 1..n like a real device reports them.
    const currentIndex = this.#currentIndex(player);
    player.queue.forEach((item, index) => {
      item.qid = String(index + 1);
    });
    player.currentQid = currentIndex === -1 ? null : String(currentIndex + 1);
    this.nextQid = player.queue.length + 1;

    this.#broadcast('player_queue_changed', { pid: attrs.pid });
    if (aid === 1 || aid === 4) {
      this.#emitNowPlaying(attrs.pid);
      this.#broadcast('player_state_changed', { pid: attrs.pid, state: 'play' });
    }
    return { message: { pid: attrs.pid, sid: attrs.sid, cid: attrs.cid ?? '', mid: attrs.mid ?? '', aid: String(aid) } };
  }

  #playStream(attrs) {
    const player = this.#player(attrs.pid);
    const station = findStation(attrs.mid);
    if (station) {
      player.station = station;
      player.currentQid = null;
      player.position = 0;
      player.duration = 0;
      player.state = 'play';
      this.#emitNowPlaying(attrs.pid);
      this.#broadcast('player_state_changed', { pid: attrs.pid, state: 'play' });
      return { message: { pid: attrs.pid, sid: attrs.sid ?? '', mid: attrs.mid } };
    }
    const track = findTrack(attrs.mid);
    if (track) return this.#addToQueue({ ...attrs, aid: '1' });
    if (attrs.url) {
      player.station = { mid: attrs.url, name: attrs.url, description: 'Streaming URL', image: art('URL') };
      player.state = 'play';
      player.position = 0;
      this.#emitNowPlaying(attrs.pid);
      this.#broadcast('player_state_changed', { pid: attrs.pid, state: 'play' });
      return { message: { pid: attrs.pid, url: attrs.url } };
    }
    throw INVALID_ID('Unknown media id');
  }

  #playInput(attrs) {
    const player = this.#player(attrs.pid);
    const sourcePlayer = attrs.spid ? this.#player(attrs.spid) : player;
    const label = attrs.input.split('/')[1].replaceAll('_', ' ');
    player.station = {
      mid: attrs.input,
      name: `${label} · ${sourcePlayer.info.name}`,
      description: 'Line input',
      image: art(attrs.input),
    };
    player.currentQid = null;
    player.position = 0;
    player.state = 'play';
    this.#emitNowPlaying(attrs.pid);
    this.#broadcast('player_state_changed', { pid: attrs.pid, state: 'play' });
    return { message: { pid: attrs.pid, input: attrs.input } };
  }

  #serviceOption(attrs) {
    const option = Number(attrs.option);
    if (option === 19) {
      // Favourite either an explicit station or whatever the player is on.
      let mid = attrs.mid;
      if (!mid && attrs.pid) mid = this.#player(attrs.pid).station?.mid;
      if (!mid || !findStation(mid)) throw INVALID_ID('Only stations can be favourited');
      if (!this.favorites.includes(mid)) this.favorites.push(mid);
      this.#broadcast('sources_changed', {});
      return { message: { option: attrs.option, mid } };
    }
    if (option === 20) {
      this.favorites = this.favorites.filter((entry) => entry !== attrs.mid);
      this.#broadcast('sources_changed', {});
      return { message: { option: attrs.option, mid: attrs.mid ?? '' } };
    }
    throw UNSUPPORTED(`Service option ${attrs.option} is not supported`);
  }
}
