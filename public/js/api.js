/** Thin fetch wrapper around the server's REST API. */

async function request(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(data?.error ?? `${method} ${url} failed (${response.status})`);
    error.status = response.status;
    error.eid = data?.eid;
    throw error;
  }
  return data;
}

const query = (params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const string = search.toString();
  return string ? `?${string}` : '';
};

export const api = {
  status: () => request('GET', '/api/status'),
  discover: () => request('POST', '/api/discover'),
  connect: (host, port) => request('POST', '/api/connect', { host, port }),
  signIn: (username, password) => request('POST', '/api/account/sign-in', { username, password }),
  signOut: () => request('POST', '/api/account/sign-out'),

  players: () => request('GET', '/api/players'),
  player: (pid) => request('GET', `/api/players/${pid}`),
  setState: (pid, state) => request('POST', `/api/players/${pid}/state`, { state }),
  next: (pid) => request('POST', `/api/players/${pid}/next`),
  previous: (pid) => request('POST', `/api/players/${pid}/previous`),
  setVolume: (pid, level) => request('POST', `/api/players/${pid}/volume`, { level }),
  setMute: (pid, muted) => request('POST', `/api/players/${pid}/mute`, { muted }),
  setPlayMode: (pid, mode) => request('POST', `/api/players/${pid}/play-mode`, mode),
  setGroup: (pids) => request('POST', '/api/groups', { pids }),

  queue: (pid, params = {}) => request('GET', `/api/players/${pid}/queue${query(params)}`),
  playQueueItem: (pid, qid) => request('POST', `/api/players/${pid}/queue/play`, { qid }),
  removeFromQueue: (pid, qids) => request('POST', `/api/players/${pid}/queue/remove`, { qids }),
  moveQueueItem: (pid, from, to) => request('POST', `/api/players/${pid}/queue/move`, { from, to }),
  clearQueue: (pid) => request('DELETE', `/api/players/${pid}/queue`),
  saveQueue: (pid, name) => request('POST', `/api/players/${pid}/queue/save`, { name }),

  sources: (refresh = false) => request('GET', `/api/sources${query({ refresh: refresh || '' })}`),
  browse: (params) => request('GET', `/api/browse${query(params)}`),
  searchCriteria: (sid) => request('GET', `/api/search-criteria${query({ sid })}`),
  search: (params) => request('GET', `/api/search${query(params)}`),

  play: (payload) => request('POST', '/api/play', payload),
  playUrl: (pid, url) => request('POST', '/api/play-url', { pid, url }),
  addFavorite: (payload) => request('POST', '/api/favorites', payload),
  removeFavorite: (mid) => request('DELETE', `/api/favorites/${encodeURIComponent(mid)}`),
};
