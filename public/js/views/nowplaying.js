/**
 * The Now Playing tab — artwork, transport, play modes, volume, and the
 * play queue for the currently selected room.
 */

import { api } from '../api.js';
import { artwork, fill, formatTime, h } from '../dom.js';
import { icon } from '../icons.js';
import { bindVolumeSlider, chooseRoom, transport } from '../actions.js';
import { showSheet } from '../components/sheet.js';
import { attempt } from '../components/toast.js';
import {
  controlPid,
  groupOf,
  interaction,
  refreshQueue,
  state,
  store,
  targetPlayer,
} from '../store.js';

export class NowPlayingView {
  constructor() {
    this.element = h('section.screen', { id: 'screen-now' });
    this.header = h('header.header');
    this.body = h('div.np');
    this.element.append(this.header, this.body);
    this.mode = 'now';
    /** Nodes updated in place by progress ticks. */
    this.progressNodes = null;

    // Skip rebuilds while a slider is being dragged; the store re-emits on release.
    store.on('players', () => {
      if (!interaction.active) this.render();
    });
    store.on('target', () => {
      this.progressNodes = null;
      void this.refreshQueueIfNeeded();
      this.render();
    });
    store.on('progress', (detail) => this.onProgress(detail));
    store.on('queue', () => {
      if (this.mode === 'queue') this.render();
    });
  }

  async activate() {
    await this.refreshQueueIfNeeded();
    this.render();
  }

  async refreshQueueIfNeeded() {
    const player = targetPlayer();
    if (!player) return;
    if (state.queue.pid !== player.pid) await refreshQueue(player.pid).catch(() => {});
  }

  render() {
    const player = targetPlayer();
    this.renderHeader(player);
    this.progressNodes = null;

    if (!player) {
      fill(this.body, h('div.empty', null, h('div.empty__title', null, 'No room selected'), 'Pick a room to see what is playing.'));
      return;
    }
    fill(this.body, this.mode === 'queue' ? this.renderQueue(player) : this.renderNow(player));
  }

  renderHeader(player) {
    const group = player ? groupOf(player.pid) : null;
    fill(
      this.header,
      h(
        'div.header__title',
        null,
        this.mode === 'queue' ? 'Queue' : 'Now Playing',
        h('span.header__sub', null, group ? group.name : player?.name ?? '—'),
      ),
      h(
        'button.iconbtn',
        {
          type: 'button',
          'aria-label': 'Change room',
          title: 'Change room',
          onclick: () => chooseRoom({ title: 'Show now playing for' }),
        },
        icon('speaker'),
      ),
      h(
        'button.iconbtn',
        {
          type: 'button',
          class: this.mode === 'queue' ? 'iconbtn--on' : '',
          'aria-label': this.mode === 'queue' ? 'Back to now playing' : 'Show queue',
          title: 'Queue',
          onclick: () => {
            this.mode = this.mode === 'queue' ? 'now' : 'queue';
            void this.refreshQueueIfNeeded();
            this.render();
          },
        },
        icon(this.mode === 'queue' ? 'disc' : 'queue'),
      ),
    );
  }

  renderNow(player) {
    const now = player.nowPlaying ?? {};
    const isRadio = now.type === 'station';
    const title = now.song || now.station || 'Nothing playing';
    const progress = state.progress.get(player.pid) ?? { position: 0, duration: 0 };

    const bar = h('input', {
      type: 'range',
      min: '0',
      max: String(Math.max(1, progress.duration || 1)),
      value: String(Math.min(progress.position, progress.duration || progress.position)),
      disabled: true,
      'aria-label': 'Playback position',
      style: { width: '100%' },
    });
    const elapsed = h('span', null, formatTime(progress.position));
    const remaining = h('span', null, isRadio || !progress.duration ? 'Live' : formatTime(progress.duration));
    this.progressNodes = { pid: player.pid, bar, elapsed, remaining, isRadio };

    return [
      artwork(now.image, title, 'np__art', title),
      h(
        'div.np__meta',
        null,
        h('div.np__title', null, title),
        h('div.np__artist', null, now.artist || (isRadio ? 'Radio' : '—')),
        now.album ? h('div.np__album', null, now.album) : null,
      ),
      h('div.np__progress', null, bar, h('div.np__times', null, elapsed, remaining)),
      h(
        'div.np__transport',
        null,
        h(
          'button.iconbtn',
          { type: 'button', 'aria-label': 'Previous', disabled: isRadio, onclick: () => transport(player.pid, 'previous') },
          icon('previous'),
        ),
        h(
          'button.iconbtn.np__play',
          {
            type: 'button',
            'aria-label': player.state === 'play' ? 'Pause' : 'Play',
            onclick: () => transport(player.pid, player.state === 'play' ? 'pause' : 'play'),
          },
          icon(player.state === 'play' ? 'pause' : 'play'),
        ),
        h(
          'button.iconbtn',
          { type: 'button', 'aria-label': 'Next', disabled: isRadio, onclick: () => transport(player.pid, 'next') },
          icon('next'),
        ),
      ),
      h(
        'div.np__modes',
        null,
        h(
          'button.iconbtn',
          {
            type: 'button',
            class: player.shuffle ? 'iconbtn--on' : '',
            'aria-label': 'Shuffle',
            title: 'Shuffle',
            onclick: () =>
              attempt(() =>
                api.setPlayMode(controlPid(player.pid), { repeat: player.repeat, shuffle: !player.shuffle }),
              ),
          },
          icon('shuffle'),
        ),
        h(
          'button.iconbtn',
          {
            type: 'button',
            class: player.repeat && player.repeat !== 'off' ? 'iconbtn--on' : '',
            'aria-label': `Repeat: ${repeatLabel(player.repeat)}`,
            title: `Repeat: ${repeatLabel(player.repeat)}`,
            onclick: () =>
              attempt(() =>
                api.setPlayMode(controlPid(player.pid), {
                  repeat: nextRepeat(player.repeat),
                  shuffle: player.shuffle,
                }),
              ),
          },
          icon(player.repeat === 'on_one' ? 'repeatOne' : 'repeat'),
        ),
        isRadio && now.mid
          ? h(
              'button.iconbtn',
              {
                type: 'button',
                'aria-label': 'Add to HEOS Favorites',
                title: 'Add to HEOS Favorites',
                onclick: () =>
                  attempt(
                    () => api.addFavorite({ pid: controlPid(player.pid), sid: now.sid, mid: now.mid, name: now.station }),
                    { success: 'Added to HEOS Favorites' },
                  ),
              },
              icon('star'),
            )
          : null,
      ),
      this.volumeControl(player),
    ];
  }

  volumeControl(player) {
    const slider = h('input', {
      type: 'range',
      min: '0',
      max: '100',
      value: String(player.volume ?? 0),
      'aria-label': 'Volume',
    });
    bindVolumeSlider(slider, player.pid);

    return h(
      'div.volume.np__volume',
      null,
      h(
        'button.iconbtn',
        {
          type: 'button',
          'aria-label': player.muted ? 'Unmute' : 'Mute',
          onclick: () => attempt(() => api.setMute(controlPid(player.pid), !player.muted)),
        },
        icon(player.muted ? 'volumeMute' : 'volume'),
      ),
      slider,
    );
  }

  renderQueue(player) {
    const { items } = state.queue;
    const currentQid = player.nowPlaying?.qid;

    const header = h(
      'div',
      { style: { width: '100%', display: 'flex', gap: '8px', justifyContent: 'space-between', alignItems: 'center' } },
      h('div.section-title', { style: { padding: '4px 0' } }, `${items.length} tracks`),
      h(
        'div',
        { style: { display: 'flex', gap: '8px' } },
        h(
          'button.btn.btn--ghost',
          {
            type: 'button',
            disabled: !items.length,
            onclick: () =>
              showSheet({
                title: 'Queue',
                items: [
                  {
                    label: 'Save as playlist',
                    icon: 'star',
                    onSelect: async () => {
                      const name = prompt('Playlist name');
                      if (name) await attempt(() => api.saveQueue(controlPid(player.pid), name), { success: 'Playlist saved' });
                    },
                  },
                  {
                    label: 'Clear queue',
                    icon: 'trash',
                    danger: true,
                    onSelect: async () => {
                      await attempt(() => api.clearQueue(controlPid(player.pid)), { success: 'Queue cleared' });
                      await refreshQueue(player.pid).catch(() => {});
                    },
                  },
                ],
              }),
          },
          icon('more'),
          'Manage',
        ),
      ),
    );

    if (!items.length) {
      return [header, h('div.empty', null, h('div.empty__title', null, 'Queue is empty'), 'Pick something from the Music tab.')];
    }

    return [
      header,
      h(
        'div.rows',
        { style: { width: '100%' } },
        items.map((item, index) =>
          h(
            'div.row',
            {
              class: String(item.qid) === String(currentQid) ? 'row--active' : '',
              role: 'button',
              tabindex: '0',
              onclick: () => attempt(() => api.playQueueItem(controlPid(player.pid), item.qid)),
            },
            h('span.row__index', null, index + 1),
            h(
              'div.row__body',
              null,
              h('div.row__title', null, item.song),
              h('div.row__sub', null, [item.artist, item.album].filter(Boolean).join(' — ')),
            ),
            h(
              'span.row__meta',
              null,
              h(
                'button.iconbtn',
                {
                  type: 'button',
                  'aria-label': `Remove ${item.song} from queue`,
                  onclick: async (event) => {
                    event.stopPropagation();
                    await attempt(() => api.removeFromQueue(controlPid(player.pid), [item.qid]));
                    await refreshQueue(player.pid).catch(() => {});
                  },
                },
                icon('trash'),
              ),
            ),
          ),
        ),
      ),
    ];
  }

  onProgress({ pid, position, duration }) {
    const nodes = this.progressNodes;
    if (!nodes || nodes.pid !== Number(pid)) return;
    nodes.bar.max = String(Math.max(1, duration || 1));
    nodes.bar.value = String(Math.min(position, duration || position));
    nodes.elapsed.textContent = formatTime(position);
    nodes.remaining.textContent = nodes.isRadio || !duration ? 'Live' : formatTime(duration);
  }
}

function nextRepeat(current) {
  if (current === 'off' || !current) return 'on_all';
  if (current === 'on_all') return 'on_one';
  return 'off';
}

function repeatLabel(current) {
  return { on_all: 'All', on_one: 'One' }[current] ?? 'Off';
}
