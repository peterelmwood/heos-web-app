/**
 * A deterministic fake music library for the mock HEOS device.
 *
 * Nothing here talks to the network: artwork is served by our own Express app
 * as generated SVG, so the demo works completely offline.
 */

import { SOURCE_IDS } from '../protocol.js';

export const art = (seed) => `/api/art/${encodeURIComponent(seed)}.svg`;

const ARTISTS = [
  {
    name: 'Aurora Field',
    genre: 'Electronic',
    albums: [
      { title: 'Northern Signals', year: 2019, tracks: ['Polar Drift', 'Signal Fire', 'Ionosphere', 'Low Sun', 'Magnetic North', 'Aurora Field', 'Tidal Lock', 'Long Winter'] },
      { title: 'Slow Machines', year: 2022, tracks: ['Slow Machines', 'Copper Wire', 'Nightshift', 'Static Bloom', 'Halide', 'Cold Start', 'Turbine'] },
    ],
  },
  {
    name: 'The Wandering Hours',
    genre: 'Indie Rock',
    albums: [
      { title: 'Paper Lanterns', year: 2017, tracks: ['Paper Lanterns', 'Cheap Seats', 'Marbles', 'Anywhere But Tuesday', 'Ferry Song', 'Held Together', 'Backroads', 'Last Call', 'Radio Silence'] },
      { title: 'Small Hours', year: 2021, tracks: ['Small Hours', 'Neon Diner', 'Two Left Feet', 'Winter Coat', 'Hollow Bell', 'Streetlight Parade'] },
    ],
  },
  {
    name: 'Mira Solvang',
    genre: 'Jazz',
    albums: [
      { title: 'Blue Room Sessions', year: 2016, tracks: ['Blue Room', 'Autumn Letters', 'Sway', 'Midnight Postcard', 'Ivory', 'Quiet Company', 'After Hours'] },
      { title: 'Harbour Lights', year: 2020, tracks: ['Harbour Lights', 'Dockside', 'Salt Air', 'Low Tide Waltz', 'Lantern', 'Homeward'] },
    ],
  },
  {
    name: 'Kaskade Ridge',
    genre: 'Ambient',
    albums: [
      { title: 'Elevation', year: 2018, tracks: ['Basecamp', 'Treeline', 'Ridgeway', 'Snowfield', 'Summit', 'Descent'] },
      { title: 'Long Exposure', year: 2023, tracks: ['Long Exposure', 'Glass Lake', 'Moraine', 'Alpenglow', 'Still Air', 'Night Hike', 'First Light'] },
    ],
  },
  {
    name: 'Delta Rhodes',
    genre: 'Soul',
    albums: [
      { title: 'Brass & Velvet', year: 2015, tracks: ['Brass & Velvet', 'Hold the Line', 'Sunday Best', 'Tell Me Twice', 'Golden Hour', 'Company Man', 'Slow Burn', 'Homegrown'] },
      { title: 'Riverwide', year: 2024, tracks: ['Riverwide', 'Undertow', 'Levee', 'Two Rivers', 'Delta Blue', 'Carry Me'] },
    ],
  },
  {
    name: 'Nocturne Assembly',
    genre: 'Classical',
    albums: [
      { title: 'Chamber Works I', year: 2014, tracks: ['Prelude in D', 'Nocturne No. 2', 'Adagio for Strings', 'Intermezzo', 'Fugue in G Minor', 'Cantabile'] },
      { title: 'Winter Pieces', year: 2022, tracks: ['First Snow', 'Frost Etude', 'Hoarfrost', 'Solstice', 'Thaw'] },
    ],
  },
  {
    name: 'Yuki & the Static',
    genre: 'Pop',
    albums: [
      { title: 'Loud Colours', year: 2021, tracks: ['Loud Colours', 'Supercut', 'Bubblegum Static', 'Overexposed', 'Talk Talk Talk', 'Fireworks Ending', 'Afterparty'] },
    ],
  },
  {
    name: 'Cobalt Line',
    genre: 'Electronic',
    albums: [
      { title: 'Transit Maps', year: 2020, tracks: ['Transit Maps', 'Platform 6', 'Night Bus', 'Interchange', 'Last Train', 'Terminus'] },
    ],
  },
];

/** @typedef {{mid: string, title: string, artist: string, album: string, albumId: string, genre: string, track: number, duration: number, image: string}} Track */

function buildLibrary() {
  /** @type {Track[]} */
  const tracks = [];
  const artists = [];
  const albums = [];
  let trackCounter = 0;

  ARTISTS.forEach((artist, artistIndex) => {
    const artistId = `artist:${artistIndex + 1}`;
    const artistAlbums = [];
    artist.albums.forEach((album, albumIndex) => {
      const albumId = `album:${artistIndex + 1}.${albumIndex + 1}`;
      const albumTracks = album.tracks.map((title, trackIndex) => {
        trackCounter += 1;
        // Deterministic 2:30–5:10 durations so progress bars look plausible.
        const duration = 150_000 + ((trackCounter * 37) % 160) * 1000;
        return {
          mid: `track:${trackCounter}`,
          title,
          artist: artist.name,
          artistId,
          album: album.title,
          albumId,
          genre: artist.genre,
          track: trackIndex + 1,
          year: album.year,
          duration,
          image: art(album.title),
        };
      });
      tracks.push(...albumTracks);
      const albumEntry = {
        cid: albumId,
        title: album.title,
        artist: artist.name,
        artistId,
        year: album.year,
        genre: artist.genre,
        image: art(album.title),
        tracks: albumTracks,
      };
      albums.push(albumEntry);
      artistAlbums.push(albumEntry);
    });
    artists.push({
      cid: artistId,
      name: artist.name,
      genre: artist.genre,
      image: art(artist.name),
      albums: artistAlbums,
    });
  });

  const genres = [...new Set(artists.map((artist) => artist.genre))].sort().map((name) => ({
    cid: `genre:${name}`,
    name,
    image: art(name),
    albums: albums.filter((album) => album.genre === name),
  }));

  return { artists, albums, genres, tracks };
}

export const library = buildLibrary();

const trackByMid = new Map(library.tracks.map((track) => [track.mid, track]));
export const findTrack = (mid) => trackByMid.get(mid);

export const playlists = [
  { cid: 'playlist:1', name: 'Morning Coffee', mids: ['track:15', 'track:38', 'track:52', 'track:9', 'track:63', 'track:27'] },
  { cid: 'playlist:2', name: 'Dinner Party', mids: ['track:31', 'track:44', 'track:57', 'track:12', 'track:70', 'track:22', 'track:48'] },
  { cid: 'playlist:3', name: 'Focus', mids: ['track:1', 'track:4', 'track:41', 'track:66', 'track:69', 'track:7'] },
  { cid: 'playlist:4', name: 'Road Trip', mids: ['track:10', 'track:19', 'track:59', 'track:35', 'track:24', 'track:73'] },
].map((playlist) => ({
  ...playlist,
  image: art(playlist.name),
  tracks: playlist.mids.map((mid) => findTrack(mid)).filter(Boolean),
}));

export const stations = [
  { mid: 'station:1', name: 'KEXP 90.3 FM', description: 'Seattle, WA', group: 'Local Radio' },
  { mid: 'station:2', name: 'WNYC 93.9 FM', description: 'New York, NY', group: 'Local Radio' },
  { mid: 'station:3', name: 'BBC Radio 6 Music', description: 'London, UK', group: 'Local Radio' },
  { mid: 'station:4', name: 'Jazz24', description: 'Straight-ahead jazz, 24/7', group: 'Music' },
  { mid: 'station:5', name: 'SomaFM Groove Salad', description: 'Ambient downtempo', group: 'Music' },
  { mid: 'station:6', name: 'Radio Paradise Mellow', description: 'Eclectic, listener supported', group: 'Music' },
  { mid: 'station:7', name: 'Classical KING FM', description: 'Classical favourites', group: 'Music' },
  { mid: 'station:8', name: 'NPR Program Stream', description: 'News and talk', group: 'Talk' },
  { mid: 'station:9', name: 'The Daily', description: 'Podcast · News', group: 'Podcasts' },
  { mid: 'station:10', name: 'Song Exploder', description: 'Podcast · Music', group: 'Podcasts' },
  { mid: 'station:11', name: 'ESPN Radio', description: 'Live sports talk', group: 'Sports' },
].map((station) => ({ ...station, image: art(station.name) }));

const stationByMid = new Map(stations.map((station) => [station.mid, station]));
export const findStation = (mid) => stationByMid.get(mid);

export const stationGroups = ['Local Radio', 'Music', 'Talk', 'Sports', 'Podcasts'];

/** Seeded so the History source has something in it before anything is played. */
export const initialHistory = ['track:6', 'track:33', 'station:5', 'track:51', 'track:18'];

export const initialFavorites = ['station:1', 'station:4', 'station:6'];

export const sources = [
  {
    sid: SOURCE_IDS.LOCAL_MUSIC,
    name: 'Local Music',
    type: 'heos_server',
    image_url: art('Local Music'),
    available: 'true',
  },
  {
    sid: SOURCE_IDS.PLAYLISTS,
    name: 'Playlists',
    type: 'heos_service',
    image_url: art('Playlists'),
    available: 'true',
  },
  {
    sid: SOURCE_IDS.HISTORY,
    name: 'History',
    type: 'heos_service',
    image_url: art('History'),
    available: 'true',
  },
  {
    sid: SOURCE_IDS.FAVORITES,
    name: 'HEOS Favorites',
    type: 'heos_service',
    image_url: art('HEOS Favorites'),
    available: 'true',
  },
  {
    sid: SOURCE_IDS.AUX_INPUT,
    name: 'AUX Input',
    type: 'heos_service',
    image_url: art('AUX Input'),
    available: 'true',
  },
  {
    sid: SOURCE_IDS.TUNEIN,
    name: 'TuneIn',
    type: 'music_service',
    image_url: art('TuneIn'),
    available: 'true',
    service_username: 'demo@heos.local',
  },
  {
    sid: SOURCE_IDS.AMAZON,
    name: 'Amazon Music',
    type: 'music_service',
    image_url: art('Amazon Music'),
    available: 'true',
    service_username: 'demo@heos.local',
  },
  {
    sid: SOURCE_IDS.SPOTIFY,
    name: 'Spotify',
    type: 'music_service',
    image_url: art('Spotify'),
    available: 'false',
  },
];

/** Physical inputs advertised per player by the AUX source. */
export const inputs = ['inputs/aux_in_1', 'inputs/line_in_1', 'inputs/optical_in_1'];

export const players = [
  { pid: 100001, name: 'Living Room', model: 'HEOS 5', version: '1.583.147', ip: '10.0.0.21', network: 'wifi', lineout: 0, serial: 'ADM0001' },
  { pid: 100002, name: 'Kitchen', model: 'HEOS 1', version: '1.583.147', ip: '10.0.0.22', network: 'wifi', lineout: 0, serial: 'ADM0002' },
  { pid: 100003, name: 'Patio', model: 'HEOS 3', version: '1.583.147', ip: '10.0.0.23', network: 'wifi', lineout: 0, serial: 'ADM0003' },
  { pid: 100004, name: 'Study', model: 'Denon AVR-X3700H', version: '1.583.147', ip: '10.0.0.24', network: 'wired', lineout: 1, serial: 'ADM0004' },
];
