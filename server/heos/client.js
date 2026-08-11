/**
 * High level HEOS client.
 *
 * Wraps a {@link HeosConnection} with the command set the web UI needs and
 * normalises the wire format (strings for everything, snake_case, `"yes"`
 * booleans) into shapes the browser can use directly.
 */

import { EventEmitter } from 'node:events';
import { HeosConnection } from './connection.js';
import { ADD_CRITERIA, SOURCE_IDS } from './protocol.js';

// HEOS is inconsistent: containers use "yes"/"no", availability uses "true"/"false".
const yes = (value) => value === 'yes' || value === 'true' || value === 'on' || value === true;
const num = (value) => (value === undefined || value === '' ? undefined : Number(value));

/** Sources whose browse results are stations rather than a library hierarchy. */
const RADIO_SOURCES = new Set([SOURCE_IDS.TUNEIN, SOURCE_IDS.IHEARTRADIO, SOURCE_IDS.SIRIUSXM]);

function normaliseSource(raw) {
  return {
    sid: num(raw.sid),
    name: raw.name,
    image: raw.image_url || null,
    type: raw.type,
    available: raw.available === undefined ? true : yes(raw.available),
    username: raw.service_username || null,
    isRadio: RADIO_SOURCES.has(num(raw.sid)),
  };
}

function normaliseBrowseItem(raw, sid) {
  const itemSid = num(raw.sid) ?? sid;
  return {
    // A stable key for list rendering; media ids are only unique per container.
    key: [itemSid, raw.cid, raw.mid, raw.name].filter(Boolean).join('|'),
    name: raw.name,
    image: raw.image_url || null,
    type: raw.type ?? (yes(raw.container) ? 'container' : 'song'),
    container: yes(raw.container),
    playable: yes(raw.playable),
    sid: itemSid,
    cid: raw.cid ?? undefined,
    mid: raw.mid ?? undefined,
    artist: raw.artist ?? undefined,
    album: raw.album ?? undefined,
    albumId: raw.album_id ?? undefined,
    // Present on AUX/input entries and HEOS service roots.
    playableInput: raw.type === 'media_input' || raw.type === 'input',
  };
}

function normaliseQueueItem(raw) {
  return {
    qid: num(raw.qid),
    mid: raw.mid,
    song: raw.song,
    album: raw.album,
    artist: raw.artist,
    image: raw.image_url || null,
    albumId: raw.album_id ?? undefined,
  };
}

function normaliseNowPlaying(raw = {}) {
  return {
    type: raw.type ?? null,
    song: raw.song ?? null,
    album: raw.album ?? null,
    artist: raw.artist ?? null,
    station: raw.station ?? null,
    image: raw.image_url || null,
    mid: raw.mid ?? null,
    qid: num(raw.qid),
    sid: num(raw.sid),
    albumId: raw.album_id ?? undefined,
  };
}

function normalisePlayer(raw) {
  return {
    pid: num(raw.pid),
    name: raw.name,
    model: raw.model,
    version: raw.version,
    ip: raw.ip,
    network: raw.network,
    lineout: num(raw.lineout),
    serial: raw.serial,
    gid: num(raw.gid),
  };
}

function normaliseGroup(raw) {
  const players = (raw.players ?? []).map((player) => ({
    pid: num(player.pid),
    name: player.name,
    role: player.role,
  }));
  return {
    gid: num(raw.gid),
    name: raw.name,
    players,
    leader: players.find((player) => player.role === 'leader')?.pid,
  };
}

export class HeosClient extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.host
   * @param {number} [options.port]
   */
  constructor({ host, port }) {
    super();
    this.host = host;
    this.connection = new HeosConnection({ host, port });
    this.signedInUser = null;

    this.connection.on('connect', async () => {
      try {
        await this.connection.send('system/prettify_json_response', { enable: 'off' });
        await this.connection.send('system/register_for_change_events', { enable: 'on' });
        await this.refreshAccount();
      } catch (err) {
        this.emit('warning', err);
      }
      this.emit('connected', { host: this.host });
    });
    this.connection.on('disconnect', () => this.emit('disconnected'));
    this.connection.on('reconnecting', (info) => this.emit('reconnecting', info));
    this.connection.on('error', (err) => this.emit('warning', err));
    this.connection.on('event', (response) => this.#handleEvent(response));
  }

  get connected() {
    return this.connection.connected;
  }

  connect() {
    return this.connection.connect();
  }

  close() {
    return this.connection.close();
  }

  #handleEvent(response) {
    const type = response.command.slice('event/'.length);
    const message = response.message;
    /** @type {Record<string, unknown>} */
    const detail = { type };
    for (const [key, value] of Object.entries(message)) {
      detail[key] = /^-?\d+$/.test(value) ? Number(value) : value;
    }
    this.emit('event', detail);
  }

  // ---------------------------------------------------------------- system

  async refreshAccount() {
    const response = await this.connection.send('system/check_account');
    this.signedInUser = response.message.signed_in !== undefined ? response.message.un ?? null : null;
    if (response.message.signed_out !== undefined) this.signedInUser = null;
    return this.signedInUser;
  }

  async signIn(username, password) {
    await this.connection.send('system/sign_in', { un: username, pw: password });
    this.signedInUser = username;
    return this.signedInUser;
  }

  async signOut() {
    await this.connection.send('system/sign_out');
    this.signedInUser = null;
  }

  // ---------------------------------------------------------------- players

  async getPlayers() {
    const response = await this.connection.send('player/get_players');
    return (response.payload ?? []).map(normalisePlayer);
  }

  async getGroups() {
    const response = await this.connection.send('group/get_groups');
    return (response.payload ?? []).map(normaliseGroup);
  }

  /**
   * Create, extend or tear down a group. Passing a single pid ungroups it.
   * @param {number[]} pids leader first
   */
  async setGroup(pids) {
    const response = await this.connection.send('group/set_group', { pid: pids.join(',') });
    return response.message;
  }

  /** Everything the UI shows for one player, in a single round trip set. */
  async getPlayerState(pid) {
    const [state, volume, mute, nowPlaying, mode] = await Promise.all([
      this.connection.send('player/get_play_state', { pid }),
      this.connection.send('player/get_volume', { pid }),
      this.connection.send('player/get_mute', { pid }),
      this.connection.send('player/get_now_playing_media', { pid }),
      this.connection.send('player/get_play_mode', { pid }),
    ]);
    return {
      pid: Number(pid),
      state: state.message.state,
      volume: num(volume.message.level) ?? 0,
      muted: mute.message.state === 'on',
      repeat: mode.message.repeat ?? 'off',
      shuffle: mode.message.shuffle === 'on',
      nowPlaying: normaliseNowPlaying(
        Array.isArray(nowPlaying.payload) ? nowPlaying.payload[0] : nowPlaying.payload,
      ),
    };
  }

  async setPlayState(pid, state) {
    await this.connection.send('player/set_play_state', { pid, state });
  }

  async next(pid) {
    await this.connection.send('player/play_next', { pid });
  }

  async previous(pid) {
    await this.connection.send('player/play_previous', { pid });
  }

  async setVolume(pid, level) {
    const clamped = Math.max(0, Math.min(100, Math.round(level)));
    await this.connection.send('player/set_volume', { pid, level: clamped });
    return clamped;
  }

  async setMute(pid, muted) {
    await this.connection.send('player/set_mute', { pid, state: muted ? 'on' : 'off' });
  }

  async setPlayMode(pid, { repeat, shuffle }) {
    await this.connection.send('player/set_play_mode', {
      pid,
      repeat: repeat ?? 'off',
      shuffle: shuffle ? 'on' : 'off',
    });
  }

  // ------------------------------------------------------------------ queue

  async getQueue(pid, { start = 0, count = 100 } = {}) {
    const response = await this.connection.send('player/get_queue', {
      pid,
      range: `${start},${start + count - 1}`,
    });
    return {
      items: (response.payload ?? []).map(normaliseQueueItem),
      start,
      returned: num(response.message.returned) ?? (response.payload ?? []).length,
      total: num(response.message.count),
    };
  }

  async playQueueItem(pid, qid) {
    await this.connection.send('player/play_queue', { pid, qid });
  }

  async removeFromQueue(pid, qids) {
    await this.connection.send('player/remove_from_queue', { pid, qid: qids.join(',') });
  }

  async clearQueue(pid) {
    await this.connection.send('player/clear_queue', { pid });
  }

  async moveQueueItem(pid, sqid, dqid) {
    await this.connection.send('player/move_queue_item', { pid, sqid, dqid });
  }

  async saveQueue(pid, name) {
    await this.connection.send('player/save_queue', { pid, name });
  }

  // ----------------------------------------------------------------- browse

  async getMusicSources({ refresh = false } = {}) {
    const response = await this.connection.send('browse/get_music_sources', {
      refresh: refresh ? 'on' : undefined,
    });
    return (response.payload ?? []).map(normaliseSource);
  }

  /**
   * Browse a source or a container inside it.
   *
   * @param {object} params
   * @param {number|string} params.sid
   * @param {string} [params.cid] container id; omit for the source root
   * @param {number} [params.start]
   * @param {number} [params.count]
   */
  async browse({ sid, cid, start = 0, count = 100 }) {
    const response = await this.connection.send('browse/browse', {
      sid,
      cid,
      range: cid === undefined && Number(sid) === SOURCE_IDS.AUX_INPUT
        ? undefined
        : `${start},${start + count - 1}`,
    });
    return {
      sid: Number(sid),
      cid,
      items: (response.payload ?? []).map((item) => normaliseBrowseItem(item, Number(sid))),
      options: flattenOptions(response.options),
      start,
      returned: num(response.message.returned) ?? (response.payload ?? []).length,
      total: num(response.message.count),
    };
  }

  /** Search criteria advertised by a service (`Artist`, `Album`, `Track`, …). */
  async getSearchCriteria(sid) {
    const response = await this.connection.send('browse/get_search_criteria', { sid });
    return (response.payload ?? []).map((criteria) => ({
      name: criteria.name,
      scid: num(criteria.scid),
      wildcard: yes(criteria.wildcard),
      playable: yes(criteria.playable),
      cid: criteria.cid ?? undefined,
    }));
  }

  async search({ sid, query, scid, start = 0, count = 50 }) {
    const response = await this.connection.send('browse/search', {
      sid,
      search: query,
      scid,
      range: `${start},${start + count - 1}`,
    });
    return {
      sid: Number(sid),
      query,
      scid: num(scid),
      items: (response.payload ?? []).map((item) => normaliseBrowseItem(item, Number(sid))),
      options: flattenOptions(response.options),
      start,
      returned: num(response.message.returned) ?? (response.payload ?? []).length,
      total: num(response.message.count),
    };
  }

  /**
   * Queue or play browsed media. Mirrors the mobile app's action sheet.
   *
   * @param {object} params
   * @param {number} params.pid target player
   * @param {number} params.sid
   * @param {string} [params.cid] container to enqueue, or the container a track lives in
   * @param {string} [params.mid] track/station id
   * @param {number} [params.aid] one of {@link ADD_CRITERIA}
   * @param {string} [params.name] required when playing a station
   * @param {boolean} [params.isStation]
   */
  async addToQueue({ pid, sid, cid, mid, aid = ADD_CRITERIA.PLAY_NOW, name, isStation }) {
    // Stations are not queueable; they are streamed directly.
    if (isStation) {
      await this.connection.send('browse/play_stream', { pid, sid, cid, mid, name });
      return { streamed: true };
    }
    await this.connection.send('browse/add_to_queue', { pid, sid, cid, mid, aid });
    return { queued: true, aid };
  }

  /** Play a physical input, e.g. `inputs/aux_in_1`. */
  async playInput({ pid, input, sourcePid }) {
    await this.connection.send('browse/play_input', { pid, input, spid: sourcePid });
  }

  /** Play a HEOS URL (used by the "play URL" affordance). */
  async playUrl(pid, url) {
    await this.connection.send('browse/play_stream', { pid, url });
  }

  /**
   * Service options such as "Add to HEOS Favorites" (option 19) and
   * "Remove from HEOS Favorites" (option 20).
   */
  async setServiceOption({ option, sid, cid, mid, pid, name, range }) {
    const response = await this.connection.send('browse/set_service_option', {
      option,
      sid,
      cid,
      mid,
      pid,
      name,
      range,
    });
    return response.payload ?? null;
  }

  async addToFavorites({ pid, sid, mid, name }) {
    // Favouriting what is playing uses pid; favouriting a browsed station uses sid+mid.
    return this.setServiceOption({ option: 19, pid, sid, mid, name });
  }

  async removeFromFavorites(mid) {
    return this.setServiceOption({ option: 20, mid });
  }

  async renamePlaylist({ sid, cid, name }) {
    await this.connection.send('browse/rename_playlist', { sid, cid, name });
  }

  async deletePlaylist({ sid, cid }) {
    await this.connection.send('browse/delete_playlist', { sid, cid });
  }
}

/**
 * `browse` responses carry options as `[{play: [{id, name}]}]`; flatten them to
 * `[{context: 'play', id, name}]`.
 */
function flattenOptions(options) {
  if (!Array.isArray(options)) return [];
  const flat = [];
  for (const group of options) {
    for (const [context, entries] of Object.entries(group ?? {})) {
      for (const entry of entries ?? []) {
        flat.push({ context, id: num(entry.id), name: entry.name });
      }
    }
  }
  return flat;
}

export { ADD_CRITERIA, SOURCE_IDS };
