/** Bootstraps the shell: tab bar, mini player, and the three screens. */

import { api } from './api.js';
import { artwork, fill, h } from './dom.js';
import { icon } from './icons.js';
import { transport } from './actions.js';
import { attempt } from './components/toast.js';
import { connectEvents } from './events.js';
import { openDevicePicker, connect } from './system.js';
import { MusicView } from './views/music.js';
import { NowPlayingView } from './views/nowplaying.js';
import { RoomsView } from './views/rooms.js';
import {
  refreshPlayers,
  refreshSources,
  refreshStatus,
  setTab,
  state,
  store,
  targetPlayer,
} from './store.js';

const TABS = [
  { id: 'rooms', label: 'Rooms', icon: 'speaker' },
  { id: 'music', label: 'Music', icon: 'music' },
  { id: 'now', label: 'Now Playing', icon: 'disc' },
];

class App {
  constructor(root) {
    this.root = root;
    this.views = {
      rooms: new RoomsView(),
      music: new MusicView(),
      now: new NowPlayingView(),
    };
    this.mini = h('button.mini', { type: 'button', 'aria-label': 'Open now playing', onclick: () => setTab('now') });
    this.miniBar = h('div.mini__bar', { style: { width: '0%' } });
    this.tabbar = h('nav.tabbar', { 'aria-label': 'Sections' });
    this.gate = null;

    fill(root, ...Object.values(this.views).map((view) => view.element), this.mini, this.tabbar);

    store.on('tab', () => this.syncTabs());
    store.on('players', () => this.renderMini());
    store.on('target', () => this.renderMini());
    store.on('progress', (detail) => this.updateMiniProgress(detail));
    store.on('status', () => this.renderGate());

    this.renderTabs();
    this.syncTabs();
  }

  renderTabs() {
    fill(
      this.tabbar,
      TABS.map((tab) =>
        h(
          'button.tab',
          {
            type: 'button',
            dataset: { tab: tab.id },
            'aria-current': state.tab === tab.id ? 'page' : null,
            onclick: () => setTab(tab.id),
          },
          icon(tab.icon),
          h('span', null, tab.label),
        ),
      ),
    );
  }

  syncTabs() {
    for (const [id, view] of Object.entries(this.views)) {
      const active = state.tab === id;
      view.element.hidden = !active;
      if (active) void view.activate?.();
    }
    for (const button of this.tabbar.children) {
      button.classList.toggle('tab--on', button.dataset.tab === state.tab);
      button.setAttribute('aria-current', button.dataset.tab === state.tab ? 'page' : 'false');
    }
    this.renderMini();
  }

  renderMini() {
    const player = targetPlayer();
    const now = player?.nowPlaying ?? {};
    const title = now.song || now.station;
    const visible = Boolean(player && title) && state.tab !== 'now';
    this.mini.hidden = !visible;
    if (!visible) return;

    fill(
      this.mini,
      artwork(now.image, title, 'mini__art', title),
      h(
        'div.mini__body',
        null,
        h('div.mini__title', null, title),
        h('div.mini__sub', null, [now.artist, player.name].filter(Boolean).join(' · ')),
      ),
      h(
        'span',
        { style: { display: 'flex' } },
        h(
          'button.iconbtn',
          {
            type: 'button',
            'aria-label': player.state === 'play' ? 'Pause' : 'Play',
            onclick: (event) => {
              event.stopPropagation();
              void transport(player.pid, player.state === 'play' ? 'pause' : 'play');
            },
          },
          icon(player.state === 'play' ? 'pause' : 'play'),
        ),
        h(
          'button.iconbtn',
          {
            type: 'button',
            'aria-label': 'Next track',
            onclick: (event) => {
              event.stopPropagation();
              void transport(player.pid, 'next');
            },
          },
          icon('next'),
        ),
      ),
      this.miniBar,
    );
    const progress = state.progress.get(player.pid);
    if (progress) this.updateMiniProgress({ pid: player.pid, ...progress });
  }

  updateMiniProgress({ pid, position, duration }) {
    const player = targetPlayer();
    if (!player || player.pid !== Number(pid) || !duration) return;
    this.miniBar.style.width = `${Math.min(100, (position / duration) * 100)}%`;
  }

  /** Full-screen takeover shown while there is nothing to control. */
  renderGate() {
    const { status } = state;
    if (status.connected) {
      this.gate?.remove();
      this.gate = null;
      return;
    }
    if (!this.gate) {
      this.gate = h('div.screen', {
        style: { position: 'absolute', inset: '0', background: 'var(--bg)', zIndex: '10' },
      });
      this.root.append(this.gate);
    }
    fill(
      this.gate,
      h(
        'div.empty',
        { style: { margin: 'auto' } },
        h('div.boot__logo', { style: { marginBottom: '18px' } }, 'HEOS'),
        h('div.empty__title', null, status.mode === 'connecting' ? 'Looking for your HEOS system…' : 'Not connected'),
        status.error ?? 'No HEOS device is currently reachable.',
        h(
          'div',
          { style: { marginTop: '18px', display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' } },
          h(
            'button.btn.btn--primary',
            {
              type: 'button',
              onclick: async () => {
                const result = await attempt(() => api.discover());
                if (result) openDevicePicker(result.devices);
              },
            },
            icon('refresh'),
            'Search again',
          ),
          h(
            'button.btn.btn--ghost',
            { type: 'button', onclick: () => connect(prompt('Device IP address') ?? '') },
            icon('link'),
            'Enter an address',
          ),
        ),
      ),
    );
  }
}

async function boot() {
  const root = document.getElementById('app');
  const app = new App(root);

  connectEvents();
  try {
    await refreshStatus();
  } catch {
    /* the gate will show the failure */
  }
  app.renderGate();

  if (state.status.connected) {
    await Promise.allSettled([refreshPlayers(), refreshSources()]);
  }
  app.syncTabs();
}

boot();
