# heos-web-app

A browser-based controller for [HEOS](https://www.denon.com/en-us/category/heos/) multi-room audio
(Denon / Marantz) that reproduces the way the HEOS mobile app lets you pick music: browse your
sources, drill into artists, albums, playlists and radio, then send what you found to any room with
**Play Now**, **Play Next**, **Add to End of Queue** or **Replace Queue and Play**.

It runs on your own machine, talks the native HEOS CLI protocol over TCP, and needs no cloud service
or vendor SDK.

```bash
npm install
npm start          # discover a speaker on the LAN, then open http://localhost:3000
npm run demo       # no hardware? run against the built-in HEOS simulator
```

## What it does

**Music tab — selecting music, the way the app does it**

- Lists every source the system exposes: Local Music (DLNA/media servers), Playlists, History,
  HEOS Favorites, AUX inputs, and each signed-in streaming service. Services you are not signed in
  to are shown greyed out with a "Sign in required" badge, exactly like the app.
- Drills through the container hierarchy — Artists → albums → tracks, Genres, playlists, radio
  categories — with a back stack, artwork, and paged loading for large libraries.
- Per-source search using the criteria the service itself advertises (Artist / Album / Track for a
  library, Station for TuneIn).
- Every row has the "…" action sheet with the four HEOS add-criteria, plus **Add to / Remove from
  HEOS Favorites** for stations. Tapping a track plays it immediately; tapping a container opens it.
- A container header (album, playlist, artist) offers **Play** and **Add to Queue** for the whole
  thing.
- A room chip in the header picks which room the music you select is sent to.
- Radio stations are streamed with `play_stream` rather than enqueued, and AUX/line inputs are
  browsable per player and playable on any room — both matching real HEOS behaviour.
- Escape hatch: play an arbitrary stream URL.

**Rooms tab**

- A card per player: current track, transport controls, volume and mute.
- HEOS-style grouping: pick a leader, tick the rooms that join it, save. Grouped rooms collapse into
  one card and transport/volume commands are routed to the group leader.
- A settings sheet for HEOS account sign-in, device discovery, and connecting to a device by address.

**Now Playing tab**

- Artwork, title/artist/album, live progress, transport, shuffle and three-state repeat, volume, and
  a one-tap favourite button while radio is playing.
- The play queue: reorderable numbering, tap to jump, swipe-free remove, clear, and save-as-playlist.

A mini player sits above the tab bar on the other tabs. Everything updates live over a WebSocket fed
by HEOS change events — volume changed on the speaker's own buttons shows up here immediately.

## Running it

### Against real hardware

```bash
npm start
```

On startup the server sends an SSDP `M-SEARCH` for `urn:schemas-denon-com:device:ACT-Denon:1` and
connects to the first speaker that answers on CLI port 1255. Any one speaker is enough — the CLI on
that device proxies the whole HEOS system, including players it is grouped with.

If discovery is blocked on your network (common with VLANs, Docker bridge networks, or a Wi-Fi AP
with multicast filtering), point at a speaker directly:

```bash
HEOS_HOST=192.168.1.50 npm start
```

You can also connect at runtime from the Rooms tab → ⓘ → *Connect to a device by address*.

### Without hardware

```bash
npm run demo
```

This starts `MockHeosDevice`, an in-process TCP server that speaks the real CLI protocol, backed by
a fake library of 8 artists, 15 albums, 4 playlists, 11 radio stations and 4 rooms. The rest of the
stack — connection, client, REST API, browser — is byte-for-byte identical to the hardware path, so
the simulator is also what the test suite runs against. Cover art is generated as SVG on the fly, so
the demo works with no internet access at all.

If discovery finds nothing, the app falls back to the simulator automatically rather than showing an
empty screen. Set `HEOS_MOCK_FALLBACK=0` to get a "not connected" screen instead.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port for the web UI |
| `HOST` | `0.0.0.0` | HTTP bind address |
| `HEOS_HOST` | — | Skip discovery, connect straight to this speaker |
| `HEOS_PORT` | `1255` | HEOS CLI port |
| `HEOS_MOCK` | `0` | Force the simulator |
| `HEOS_MOCK_FALLBACK` | `1` | Use the simulator when discovery finds nothing |
| `HEOS_DISCOVERY_TIMEOUT` | `5000` | How long to listen for SSDP replies, in ms |
| `HEOS_USERNAME` / `HEOS_PASSWORD` | — | HEOS account, signed in on connect to unlock services |

Credentials are only ever sent to the speaker over the local `sign_in` command; nothing is stored on
disk.

## How it is put together

```
server/
  heos/
    protocol.js     heos:// command building, response/message parsing, error ids
    connection.js   one TCP socket, serialised command queue, heartbeat, reconnect
    client.js       high level API; normalises "yes"/"true"/strings into real types
    discovery.js    SSDP M-SEARCH + UPnP friendly-name lookup
    manager.js      picks configured host → discovery → simulator, owns the client
    mock/           the device simulator and its fake catalogue
  api/routes.js     REST surface + generated SVG artwork
  ws/hub.js         broadcasts HEOS events, enriched with fresh player state
public/             zero-build ES modules: dom helpers, store, three views
test/               protocol unit tests + end-to-end tests over real TCP
```

Two details worth knowing if you extend it:

- **HEOS processes one command per connection at a time.** `connection.js` therefore queues commands
  and correlates each response by command path, swallowing the `command under process`
  acknowledgement that long browses send first.
- **The wire format is inconsistent.** Containers use `"yes"`/`"no"`, source availability uses
  `"true"`/`"false"`, ids are strings, and the `message` field is a percent-encoded query string.
  All of that is normalised in `client.js` so no other layer has to care.

## REST API

The browser client is a normal consumer of the HTTP API, so anything the UI can do you can script:

```bash
curl localhost:3000/api/sources
curl 'localhost:3000/api/browse?sid=1024&cid=albums'
curl 'localhost:3000/api/search?sid=1024&q=night&scid=3'
curl -X POST localhost:3000/api/play \
     -H 'content-type: application/json' \
     -d '{"pid":100001,"sid":1024,"cid":"album:1.1","action":"REPLACE_AND_PLAY"}'
```

`action` is one of `PLAY_NOW`, `PLAY_NEXT`, `ADD_TO_END`, `REPLACE_AND_PLAY`. Failures come back as
`{"error": "...", "eid": 6}`, carrying the device's own error id and wording.

## Tests

```bash
npm test              # everything
npm run test:unit     # protocol, client and launch tests — no browser needed
npm run test:browser  # the UI, driven in Chromium
```

33 tests across four files:

- `protocol.test.js` — command encoding and response parsing.
- `client.test.js` — boots the simulator on a real socket and drives the real client through
  browsing, paging, search, all four add-criteria, queue editing, transport, grouping, favourites,
  AUX inputs and change events.
- `startup.test.js` — spawns `node server/index.js` as a child process and checks it actually
  serves, including from a path containing a space and a symlink, and that bad input is rejected by
  the API rather than forwarded to the device.
- `browser.test.js` — drives the real UI in Chromium against the real server: the browse hierarchy,
  the action sheet, the mini player, live progress from device events, search, and volume
  interaction.

The browser tests need a Chromium:

```bash
npx playwright install chromium
```

Without one they **skip** rather than fail, so `npm test` stays useful on a machine that only has
the runtime dependencies. They also honour `HEOS_TEST_CHROMIUM=/path/to/chrome` if you would rather
point at a browser you already have, and `HEOS_SKIP_BROWSER_TESTS=1` to opt out entirely.

They earn their keep: several bugs here were only reachable with a real pointer and a live
WebSocket — a volume drag that landed on 0 because the view rebuilt the slider mid-gesture, keyboard
adjustment that dropped every keypress after the first for the same reason, and one HTTP request per
pixel of slider travel. Each has an assertion, and each assertion was checked to fail when its fix
is reverted.

## Licence

MIT
