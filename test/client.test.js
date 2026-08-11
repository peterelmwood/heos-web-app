/** End-to-end tests: real client, real TCP, against the device simulator. */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import { MockHeosDevice } from '../server/heos/mock/device.js';
import { HeosClient, ADD_CRITERIA, SOURCE_IDS } from '../server/heos/client.js';

/** @type {MockHeosDevice} */
let device;
/** @type {HeosClient} */
let client;
let pid;

before(async () => {
  device = new MockHeosDevice({ port: 0 });
  const { host, port } = await device.start();
  client = new HeosClient({ host, port });
  await client.connect();
  // The connect handler registers for events; give it a moment to settle.
  await new Promise((resolve) => setTimeout(resolve, 50));
  pid = (await client.getPlayers())[0].pid;
});

after(async () => {
  await client.close();
  await device.stop();
});

test('lists players with normalised fields', async () => {
  const players = await client.getPlayers();
  assert.ok(players.length >= 2);
  assert.equal(typeof players[0].pid, 'number');
  assert.equal(players[0].name, 'Living Room');
});

test('lists the music sources a HEOS system exposes', async () => {
  const sources = await client.getMusicSources();
  const names = sources.map((source) => source.name);
  for (const expected of ['Local Music', 'Playlists', 'History', 'HEOS Favorites', 'AUX Input', 'TuneIn']) {
    assert.ok(names.includes(expected), `expected source ${expected}`);
  }
  assert.equal(sources.find((source) => source.name === 'Local Music').available, true);
  const spotify = sources.find((source) => source.name === 'Spotify');
  assert.equal(spotify.available, false, 'signed-out services report as unavailable');
});

test('browses from a source root down to tracks', async () => {
  const root = await client.browse({ sid: SOURCE_IDS.LOCAL_MUSIC });
  const artists = root.items.find((item) => item.name === 'Artists');
  assert.ok(artists?.container);

  const artistList = await client.browse({ sid: SOURCE_IDS.LOCAL_MUSIC, cid: artists.cid });
  assert.ok(artistList.items.length > 0);
  assert.equal(artistList.items[0].type, 'artist');

  const albums = await client.browse({ sid: SOURCE_IDS.LOCAL_MUSIC, cid: artistList.items[0].cid });
  assert.equal(albums.items[0].type, 'album');

  const tracks = await client.browse({ sid: SOURCE_IDS.LOCAL_MUSIC, cid: albums.items[0].cid });
  assert.equal(tracks.items[0].type, 'song');
  assert.equal(tracks.items[0].playable, true);
  assert.ok(tracks.items[0].mid);
});

test('paging honours the requested range', async () => {
  const first = await client.browse({ sid: SOURCE_IDS.LOCAL_MUSIC, cid: 'songs', start: 0, count: 5 });
  assert.equal(first.items.length, 5);
  assert.ok(first.total > 5);

  const second = await client.browse({ sid: SOURCE_IDS.LOCAL_MUSIC, cid: 'songs', start: 5, count: 5 });
  assert.equal(second.items.length, 5);
  assert.notEqual(first.items[0].mid, second.items[0].mid);
});

test('search returns matches for the selected criteria', async () => {
  const criteria = await client.getSearchCriteria(SOURCE_IDS.LOCAL_MUSIC);
  const track = criteria.find((entry) => entry.name === 'Track');
  assert.ok(track);

  const results = await client.search({ sid: SOURCE_IDS.LOCAL_MUSIC, query: 'night', scid: track.scid });
  assert.ok(results.items.length > 0);
  for (const item of results.items) {
    assert.match(item.name.toLowerCase(), /night/);
    assert.equal(item.type, 'song');
  }
});

test('add_to_queue criteria behave like the mobile action sheet', async () => {
  const albums = await client.browse({ sid: SOURCE_IDS.LOCAL_MUSIC, cid: 'albums' });
  const album = albums.items[0];
  const other = albums.items[1];

  // Replace queue and play.
  await client.addToQueue({ pid, sid: SOURCE_IDS.LOCAL_MUSIC, cid: album.cid, aid: ADD_CRITERIA.REPLACE_AND_PLAY });
  let queue = await client.getQueue(pid);
  const albumTracks = await client.browse({ sid: SOURCE_IDS.LOCAL_MUSIC, cid: album.cid });
  assert.equal(queue.items.length, albumTracks.items.length);

  let stateNow = await client.getPlayerState(pid);
  assert.equal(stateNow.state, 'play');
  assert.equal(stateNow.nowPlaying.song, albumTracks.items[0].name);

  // Add to end appends.
  await client.addToQueue({ pid, sid: SOURCE_IDS.LOCAL_MUSIC, cid: other.cid, aid: ADD_CRITERIA.ADD_TO_END });
  const grown = await client.getQueue(pid);
  assert.ok(grown.items.length > queue.items.length);
  assert.equal(grown.items[0].song, queue.items[0].song, 'existing queue order is preserved');

  // Play next inserts directly after the current track.
  const single = albumTracks.items.at(-1);
  await client.addToQueue({
    pid,
    sid: SOURCE_IDS.LOCAL_MUSIC,
    cid: album.cid,
    mid: single.mid,
    aid: ADD_CRITERIA.PLAY_NEXT,
  });
  queue = await client.getQueue(pid);
  stateNow = await client.getPlayerState(pid);
  const currentIndex = queue.items.findIndex((item) => String(item.qid) === String(stateNow.nowPlaying.qid));
  assert.equal(queue.items[currentIndex + 1].song, single.name);

  // Play now starts the selection immediately.
  await client.addToQueue({
    pid,
    sid: SOURCE_IDS.LOCAL_MUSIC,
    cid: album.cid,
    mid: albumTracks.items[2].mid,
    aid: ADD_CRITERIA.PLAY_NOW,
  });
  stateNow = await client.getPlayerState(pid);
  assert.equal(stateNow.nowPlaying.song, albumTracks.items[2].name);
});

test('transport, volume and play mode round-trip', async () => {
  await client.setPlayState(pid, 'pause');
  assert.equal((await client.getPlayerState(pid)).state, 'pause');

  await client.setVolume(pid, 41);
  assert.equal((await client.getPlayerState(pid)).volume, 41);

  await client.setMute(pid, true);
  assert.equal((await client.getPlayerState(pid)).muted, true);
  await client.setMute(pid, false);

  await client.setPlayMode(pid, { repeat: 'on_all', shuffle: true });
  const state = await client.getPlayerState(pid);
  assert.equal(state.repeat, 'on_all');
  assert.equal(state.shuffle, true);
});

test('queue items can be played, removed and cleared', async () => {
  const queue = await client.getQueue(pid);
  const second = queue.items[1];
  await client.playQueueItem(pid, second.qid);
  assert.equal((await client.getPlayerState(pid)).nowPlaying.song, second.song);

  await client.removeFromQueue(pid, [queue.items[0].qid]);
  const shrunk = await client.getQueue(pid);
  assert.equal(shrunk.items.length, queue.items.length - 1);

  await client.clearQueue(pid);
  assert.equal((await client.getQueue(pid)).items.length, 0);
});

test('stations stream directly and can be favourited', async () => {
  const groups = await client.browse({ sid: SOURCE_IDS.TUNEIN });
  const stations = await client.browse({ sid: SOURCE_IDS.TUNEIN, cid: groups.items[0].cid });
  const station = stations.items[0];
  assert.equal(station.type, 'station');

  await client.addToQueue({ pid, sid: SOURCE_IDS.TUNEIN, mid: station.mid, name: station.name, isStation: true });
  const state = await client.getPlayerState(pid);
  assert.equal(state.nowPlaying.type, 'station');
  assert.equal(state.nowPlaying.station, station.name);

  const music = await client.browse({ sid: SOURCE_IDS.TUNEIN, cid: 'tunein:Music' });
  const target = music.items.find((item) => item.name === 'Jazz24');
  await client.removeFromFavorites(target.mid);
  let favorites = await client.browse({ sid: SOURCE_IDS.FAVORITES });
  assert.ok(!favorites.items.some((item) => item.mid === target.mid));

  await client.addToFavorites({ sid: SOURCE_IDS.TUNEIN, mid: target.mid, name: target.name });
  favorites = await client.browse({ sid: SOURCE_IDS.FAVORITES });
  assert.ok(favorites.items.some((item) => item.mid === target.mid));
});

test('AUX inputs are browsable per player and playable', async () => {
  const rooms = await client.browse({ sid: SOURCE_IDS.AUX_INPUT });
  assert.ok(rooms.items.length >= 2);
  const inputs = await client.browse({ sid: SOURCE_IDS.AUX_INPUT, cid: rooms.items[0].cid });
  assert.equal(inputs.items[0].type, 'media_input');

  await client.playInput({ pid, input: inputs.items[0].mid });
  const state = await client.getPlayerState(pid);
  assert.equal(state.state, 'play');
});

test('grouping creates and dissolves a group', async () => {
  const players = await client.getPlayers();
  await client.setGroup([players[0].pid, players[1].pid]);
  let groups = await client.getGroups();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].players.length, 2);
  assert.equal(groups[0].leader, players[0].pid);

  await client.setGroup([players[0].pid]);
  groups = await client.getGroups();
  assert.equal(groups.length, 0);
});

test('change events reach the client', async () => {
  const seen = once(client, 'event');
  await client.setVolume(pid, 33);
  const [event] = await seen;
  assert.equal(event.type, 'player_volume_changed');
  assert.equal(event.pid, pid);
  assert.equal(event.level, 33);
});

test('failures surface the HEOS error id', async () => {
  await assert.rejects(() => client.browse({ sid: 9999 }), (err) => err.eid === 6);
});
