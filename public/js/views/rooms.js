/**
 * The Rooms tab — every player on the system, with transport, volume and
 * HEOS-style grouping (pick a leader, tick the rooms that join it).
 */

import { api } from '../api.js';
import { artwork, fill, h } from '../dom.js';
import { icon } from '../icons.js';
import { transport } from '../actions.js';
import { attempt } from '../components/toast.js';
import { openSystemSheet } from '../system.js';
import { controlPid, groupOf, refreshPlayers, setTab, setTarget, setLocalVolume, state, store } from '../store.js';

/** Coalesce slider drags into at most one request per player per 120ms. */
function throttleByKey(fn, wait = 120) {
  const timers = new Map();
  const pending = new Map();
  return (key, ...args) => {
    pending.set(key, args);
    if (timers.has(key)) return;
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        const latest = pending.get(key);
        pending.delete(key);
        if (latest) fn(key, ...latest);
      }, wait),
    );
  };
}

const pushVolume = throttleByKey((pid, level) => {
  api.setVolume(pid, level).catch(() => {});
});

export class RoomsView {
  constructor() {
    this.element = h('section.screen', { id: 'screen-rooms' });
    this.header = h('header.header');
    this.body = h('div.scroll');
    this.element.append(this.header, this.body);
    /** @type {null | {leader: number, members: Set<number>}} */
    this.grouping = null;

    store.on('players', () => this.render());
    store.on('target', () => this.render());
  }

  async activate() {
    if (!state.players.length) await refreshPlayers().catch(() => {});
    this.render();
  }

  render() {
    this.renderHeader();
    const cards = [];
    const seen = new Set();

    for (const player of state.players) {
      if (seen.has(player.pid)) continue;
      const group = groupOf(player.pid);
      if (group) {
        for (const member of group.players) seen.add(member.pid);
        cards.push(this.card(this.playerFor(group.leader ?? group.players[0].pid), group));
      } else {
        seen.add(player.pid);
        cards.push(this.card(player, null));
      }
    }

    fill(
      this.body,
      state.players.length
        ? h('div.rooms', null, cards)
        : h('div.empty', null, h('div.empty__title', null, 'No rooms yet'), 'Waiting for HEOS players to appear.'),
      this.grouping ? this.groupingPanel() : null,
    );
  }

  playerFor(pid) {
    return state.players.find((player) => player.pid === Number(pid)) ?? state.players[0];
  }

  renderHeader() {
    fill(
      this.header,
      h('div.header__title', null, 'Rooms', h('span.header__sub', null, `${state.players.length} players`)),
      h(
        'button.iconbtn',
        { type: 'button', 'aria-label': 'System settings', title: 'HEOS system', onclick: () => openSystemSheet() },
        icon('info'),
      ),
      this.grouping
        ? h('button.btn.btn--ghost', { type: 'button', onclick: () => this.cancelGrouping() }, 'Cancel')
        : h(
            'button.iconbtn',
            { type: 'button', 'aria-label': 'Group rooms', title: 'Group rooms', onclick: () => this.startGrouping() },
            icon('group'),
          ),
    );
  }

  card(player, group) {
    if (!player) return null;
    const selected = player.pid === state.targetPid;
    const now = player.nowPlaying ?? {};
    const nowLine = now.song || now.station
      ? [now.song || now.station, now.artist].filter(Boolean).join(' — ')
      : 'Nothing playing';

    return h(
      'div.roomcard',
      { class: selected ? 'roomcard--selected' : '' },
      h(
        'div.roomcard__head',
        null,
        h(
          'button',
          {
            type: 'button',
            style: { display: 'contents' },
            'aria-label': `Select ${group?.name ?? player.name}`,
            onclick: () => setTarget(player.pid),
          },
          artwork(now.image, nowLine, 'roomcard__art', group?.name ?? player.name),
        ),
        h(
          'div',
          { style: { flex: '1', minWidth: 0 } },
          h(
            'div.roomcard__name',
            null,
            group ? group.name : player.name,
            group ? h('span.row__badge', null, `${group.players.length} rooms`) : null,
          ),
          h('div.roomcard__now', null, nowLine),
        ),
        h(
          'div.roomcard__transport',
          null,
          h(
            'button.iconbtn',
            { type: 'button', 'aria-label': 'Previous', onclick: () => transport(player.pid, 'previous') },
            icon('previous'),
          ),
          h(
            'button.iconbtn',
            {
              type: 'button',
              'aria-label': player.state === 'play' ? 'Pause' : 'Play',
              onclick: () => transport(player.pid, player.state === 'play' ? 'pause' : 'play'),
            },
            icon(player.state === 'play' ? 'pause' : 'play'),
          ),
          h(
            'button.iconbtn',
            { type: 'button', 'aria-label': 'Next', onclick: () => transport(player.pid, 'next') },
            icon('next'),
          ),
          h(
            'button.iconbtn',
            {
              type: 'button',
              'aria-label': 'Open now playing',
              onclick: () => {
                setTarget(player.pid);
                setTab('now');
              },
            },
            icon('chevron'),
          ),
        ),
      ),
      this.volumeRow(player),
      group
        ? h(
            'div',
            { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
            group.players.map((member) =>
              h('span.chip', { style: { padding: '4px 10px', fontSize: '12px' } }, member.name),
            ),
            h(
              'button.chip',
              { type: 'button', style: { padding: '4px 10px', fontSize: '12px' }, onclick: () => this.ungroup(group) },
              'Ungroup',
            ),
          )
        : null,
    );
  }

  volumeRow(player) {
    const slider = h('input', {
      type: 'range',
      min: '0',
      max: '100',
      value: String(player.volume ?? 0),
      'aria-label': `Volume for ${player.name}`,
    });
    slider.addEventListener('input', () => {
      const level = Number(slider.value);
      setLocalVolume(player.pid, level);
      pushVolume(controlPid(player.pid), level);
    });

    return h(
      'div.volume',
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
      h('span', { style: { width: '30px', textAlign: 'right', color: 'var(--text-faint)', fontSize: '13px' } },
        String(player.volume ?? 0)),
    );
  }

  // ------------------------------------------------------------- grouping

  startGrouping() {
    const leader = state.targetPid ?? state.players[0]?.pid;
    if (!leader) return;
    const existing = groupOf(leader);
    this.grouping = {
      leader,
      members: new Set(existing ? existing.players.map((member) => member.pid) : [leader]),
    };
    this.render();
  }

  cancelGrouping() {
    this.grouping = null;
    this.render();
  }

  groupingPanel() {
    const { leader, members } = this.grouping;
    return h(
      'div',
      { style: { padding: '0 14px 20px' } },
      h('div.section-title', { style: { padding: '4px 2px 10px' } },
        `Group with ${this.playerFor(leader)?.name ?? 'room'}`),
      h(
        'div.grouping',
        { style: { padding: 0 } },
        state.players.map((player) => {
          const on = members.has(player.pid);
          const isLeader = player.pid === leader;
          return h(
            'button.chip',
            {
              type: 'button',
              class: on ? 'chip--on' : '',
              disabled: isLeader,
              onclick: () => {
                if (isLeader) return;
                if (on) members.delete(player.pid);
                else members.add(player.pid);
                this.render();
              },
            },
            player.name,
            isLeader ? ' (leader)' : '',
          );
        }),
      ),
      h(
        'div',
        { style: { display: 'flex', gap: '8px', marginTop: '14px' } },
        h('button.btn.btn--primary', { type: 'button', onclick: () => this.saveGrouping() }, icon('check'), 'Save group'),
        h('button.btn.btn--ghost', { type: 'button', onclick: () => this.cancelGrouping() }, 'Cancel'),
      ),
    );
  }

  async saveGrouping() {
    const { leader, members } = this.grouping;
    const pids = [leader, ...[...members].filter((pid) => pid !== leader)];
    this.grouping = null;
    await attempt(() => api.setGroup(pids), {
      success: pids.length > 1 ? 'Rooms grouped' : 'Room ungrouped',
    });
    await refreshPlayers().catch(() => {});
  }

  async ungroup(group) {
    await attempt(() => api.setGroup([group.leader ?? group.players[0].pid]), { success: 'Rooms ungrouped' });
    await refreshPlayers().catch(() => {});
  }
}
