/**
 * Encoding/decoding helpers for the HEOS CLI protocol.
 *
 * The protocol is a line oriented request/response protocol spoken over TCP
 * port 1255. A request looks like:
 *
 *     heos://player/set_volume?pid=12345&level=30\r\n
 *
 * and every response is a single line of JSON:
 *
 *     {"heos": {"command": "player/set_volume", "result": "success",
 *               "message": "pid=12345&level=30"}}
 *
 * The `message` field is a query string, so it is parsed into a plain object
 * everywhere in this codebase. Unsolicited event lines use the same envelope
 * but carry a `command` starting with `event/` and no `result`.
 */

export const HEOS_PORT = 1255;

/** Characters the CLI spec requires to be percent encoded inside attribute values. */
const RESERVED = {
  '&': '%26',
  '=': '%3D',
  '%': '%25',
};

/**
 * Percent encode a single attribute value.
 *
 * `encodeURIComponent` is deliberately not used on its own: HEOS devices are
 * happy with raw spaces and unicode in search terms but choke when `&`, `=`
 * or `%` arrive unescaped, and some firmware revisions reject the over-eager
 * escaping that `encodeURIComponent` produces for characters like `'`.
 */
export function encodeValue(value) {
  return String(value).replace(/[&=%]/g, (char) => RESERVED[char]);
}

/** Decode a percent encoded attribute value coming back from a device. */
export function decodeValue(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    // Some sources return stray `%` characters that are not valid escapes.
    return value;
  }
}

/**
 * Build a `heos://` command line (without the trailing CRLF).
 *
 * @param {string} path command path such as `player/set_volume`
 * @param {Record<string, string | number | undefined | null>} [attrs]
 */
export function buildCommand(path, attrs = {}) {
  const pairs = Object.entries(attrs)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${encodeValue(value)}`);
  return pairs.length ? `heos://${path}?${pairs.join('&')}` : `heos://${path}`;
}

/**
 * Parse a `heos://` command line into its path and attributes.
 * Used by the mock device to interpret incoming requests.
 */
export function parseCommand(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('heos://')) {
    throw new Error(`Not a HEOS command: ${line}`);
  }
  const withoutScheme = trimmed.slice('heos://'.length);
  const queryStart = withoutScheme.indexOf('?');
  const path = queryStart === -1 ? withoutScheme : withoutScheme.slice(0, queryStart);
  const query = queryStart === -1 ? '' : withoutScheme.slice(queryStart + 1);
  return { path, attrs: parseAttributes(query) };
}

/**
 * Parse a HEOS query string (`pid=1&level=30`) into an object.
 * Attributes without a value (`heos://system/sign_in?un`) map to `''`.
 */
export function parseAttributes(query) {
  const attrs = {};
  if (!query) return attrs;
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq === -1) {
      attrs[decodeValue(part)] = '';
    } else {
      attrs[decodeValue(part.slice(0, eq))] = decodeValue(part.slice(eq + 1));
    }
  }
  return attrs;
}

/** Serialise attributes back into a HEOS `message` string. */
export function stringifyAttributes(attrs = {}) {
  return Object.entries(attrs)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => (value === '' ? key : `${key}=${encodeValue(value)}`))
    .join('&');
}

/**
 * Normalise a raw response line into a friendlier shape.
 *
 * @param {string} line one line of JSON as received from the device
 */
export function parseResponse(line) {
  const raw = JSON.parse(line);
  const envelope = raw.heos ?? {};
  const command = envelope.command ?? '';
  const message = parseAttributes(envelope.message ?? '');
  return {
    command,
    isEvent: command.startsWith('event/'),
    result: envelope.result,
    success: envelope.result === 'success',
    /** True while the device is still working on a long running browse. */
    underProcess: 'command under process' in message || envelope.message === 'command under process',
    message,
    payload: raw.payload,
    options: raw.options,
    raw,
  };
}

/**
 * Turn a failed response into an `Error` carrying the HEOS error id/text.
 * Failures arrive as `message=eid=6&text=Invalid%20ID`.
 */
export function responseError(response) {
  const { eid, text } = response.message;
  const detail = [text, eid && `(eid ${eid})`].filter(Boolean).join(' ');
  const error = new Error(detail || `HEOS command ${response.command} failed`);
  error.eid = eid ? Number(eid) : undefined;
  error.command = response.command;
  return error;
}

/** `add_to_queue` criteria ids, mirroring the action sheet in the mobile app. */
export const ADD_CRITERIA = {
  PLAY_NOW: 1,
  PLAY_NEXT: 2,
  ADD_TO_END: 3,
  REPLACE_AND_PLAY: 4,
};

/** Well known source ids reported by `browse/get_music_sources`. */
export const SOURCE_IDS = {
  PANDORA: 1,
  RHAPSODY: 2,
  TUNEIN: 3,
  SPOTIFY: 4,
  DEEZER: 5,
  NAPSTER: 6,
  IHEARTRADIO: 7,
  SIRIUSXM: 8,
  SOUNDCLOUD: 9,
  TIDAL: 10,
  AMAZON: 13,
  LOCAL_MUSIC: 1024,
  PLAYLISTS: 1025,
  HISTORY: 1026,
  AUX_INPUT: 1027,
  FAVORITES: 1028,
};
