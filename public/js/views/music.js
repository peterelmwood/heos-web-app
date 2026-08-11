/**
 * The Music tab — the HEOS app's music selection flow.
 *
 * A navigation stack of browse levels: sources → containers → tracks, with
 * per-source search, paging, and the "…" action sheet on every row.
 */

import { api } from '../api.js';
import { artwork, debounce, fill, h } from '../dom.js';
import { icon } from '../icons.js';
import { chooseRoom, describeType, openItemActions, playItem } from '../actions.js';
import { showSheet } from '../components/sheet.js';
import { attempt } from '../components/toast.js';
import { setTab, state, store, targetPlayer } from '../store.js';

const PAGE_SIZE = 100;
const FAVORITES_SID = 1028;

export class MusicView {
  constructor() {
    this.element = h('section.screen', { id: 'screen-music' });
    this.header = h('header.header');
    this.body = h('div.scroll');
    this.element.append(this.header, this.body);

    /** @type {Array<object>} navigation stack; index 0 is the source list */
    this.stack = [{ kind: 'sources', title: 'Music' }];
    this.rowNodes = new Map();

    store.on('sources', () => {
      if (this.current().kind === 'sources') this.render();
    });
    store.on('players', () => this.applyNowPlaying());
    store.on('target', () => this.renderHeader());
  }

  current() {
    return this.stack[this.stack.length - 1];
  }

  async activate() {
    if (!state.sources.length) await this.loadSources();
    this.render();
  }

  async loadSources() {
    this.stack = [{ kind: 'sources', title: 'Music', loading: true }];
    this.render();
    try {
      const { sources } = await api.sources();
      state.sources = sources;
      store.emit('sources', sources);
    } catch (err) {
      this.current().error = err.message;
    }
    this.current().loading = false;
    this.render();
  }

  // ------------------------------------------------------------ navigation

  async open(level) {
    this.stack.push(level);
    this.render();
    await this.load(level);
  }

  back() {
    if (this.stack.length <= 1) return;
    this.stack.pop();
    this.render();
  }

  /** Jump straight to a source, used by the "Browse music" shortcuts. */
  async openSource(source) {
    await this.open({
      kind: 'browse',
      sid: source.sid,
      cid: undefined,
      title: source.name,
      subtitle: describeType(source.type),
      source,
      items: [],
      loading: true,
      searchable: true,
    });
  }

  async openContainer(item, parent) {
    await this.open({
      kind: 'browse',
      sid: item.sid ?? parent.sid,
      cid: item.cid,
      title: item.name,
      subtitle: item.artist ?? describeType(item.type),
      source: parent.source,
      container: item,
      items: [],
      loading: true,
    });
  }

  async load(level, { append = false } = {}) {
    level.loading = true;
    if (!append) level.items = [];
    this.render();
    try {
      const start = append ? level.items.length : 0;
      const result = await api.browse({ sid: level.sid, cid: level.cid, start, count: PAGE_SIZE });
      level.items = append ? [...level.items, ...result.items] : result.items;
      level.total = result.total ?? level.items.length;
      level.options = result.options ?? [];
      level.error = null;
      if (level.searchable && level.criteria === undefined) void this.loadCriteria(level);
    } catch (err) {
      level.error = err.message;
    }
    level.loading = false;
    this.render();
  }

  async loadCriteria(level) {
    try {
      const { criteria } = await api.searchCriteria(level.sid);
      level.criteria = criteria;
    } catch {
      level.criteria = [];
    }
    if (this.current() === level) this.render();
  }

  async runSearch(level, query, scid) {
    level.query = query;
    level.scid = scid;
    if (!query.trim()) {
      level.results = null;
      this.render();
      return;
    }
    level.searching = true;
    this.render();
    try {
      const result = await api.search({ sid: level.sid, q: query, scid, count: 60 });
      level.results = result.items;
      level.resultsTotal = result.total ?? result.items.length;
      level.error = null;
    } catch (err) {
      level.results = [];
      level.error = err.message;
    }
    level.searching = false;
    this.render();
  }

  // --------------------------------------------------------------- render

  render() {
    this.renderHeader();
    this.rowNodes = new Map();
    const level = this.current();
    fill(this.body, level.kind === 'sources' ? this.renderSources() : this.renderBrowse(level));
    this.applyNowPlaying();
  }

  renderHeader() {
    const level = this.current();
    const player = targetPlayer();
    fill(
      this.header,
      this.stack.length > 1
        ? h('button.iconbtn', { type: 'button', 'aria-label': 'Back', onclick: () => this.back() }, icon('back'))
        : null,
      h(
        'div.header__title',
        null,
        level.title,
        level.subtitle ? h('span.header__sub', null, level.subtitle) : null,
      ),
      level.kind === 'sources'
        ? h(
            'button.iconbtn',
            { type: 'button', 'aria-label': 'Refresh sources', onclick: () => this.loadSources() },
            icon('refresh'),
          )
        : null,
      h(
        'button.roomchip',
        { type: 'button', title: 'Choose the room music plays in', onclick: () => chooseRoom() },
        icon('speaker'),
        h('span', null, player?.name ?? 'No room'),
      ),
    );
  }

  renderSources() {
    const level = this.current();
    if (level.loading) return loading();
    if (level.error) return errorState(level.error, () => this.loadSources());
    if (!state.sources.length) {
      return empty('No music sources', 'Sign in to a music service in the HEOS app, or add a media server.');
    }

    const local = state.sources.filter((source) => source.type !== 'music_service');
    const services = state.sources.filter((source) => source.type === 'music_service');

    return [
      local.length ? h('div.section-title', null, 'On this system') : null,
      h('div.rows', null, local.map((source) => this.sourceRow(source))),
      services.length ? h('div.section-title', null, 'Music services') : null,
      h('div.rows', null, services.map((source) => this.sourceRow(source))),
      h(
        'div',
        { style: { padding: '18px 16px 8px' } },
        h(
          'button.btn.btn--ghost.btn--block',
          { type: 'button', onclick: () => this.promptForUrl() },
          icon('link'),
          'Play a stream URL',
        ),
      ),
    ];
  }

  sourceRow(source) {
    const disabled = !source.available;
    return h(
      'button.row',
      {
        type: 'button',
        class: disabled ? 'row--disabled' : '',
        disabled,
        onclick: disabled ? undefined : () => this.openSource(source),
      },
      artwork(source.image, source.name, 'row__art', source.name),
      h(
        'div.row__body',
        null,
        h('div.row__title', null, source.name),
        h('div.row__sub', null, source.username ?? describeType(source.type)),
      ),
      disabled ? h('span.row__badge', null, 'Sign in required') : h('span.row__meta', null, icon('chevron')),
    );
  }

  renderBrowse(level) {
    const showingResults = Array.isArray(level.results);
    const items = showingResults ? level.results : level.items;
    const nodes = [];

    if (level.searchable && level.criteria?.length) nodes.push(this.renderSearchBar(level));
    if (level.container) nodes.push(this.renderHero(level));

    if (level.loading || level.searching) {
      nodes.push(loading());
      return nodes;
    }
    if (level.error) {
      nodes.push(errorState(level.error, () => this.load(level)));
      return nodes;
    }
    if (!items.length) {
      nodes.push(
        showingResults
          ? empty('No results', `Nothing matched “${level.query}”.`)
          : empty('Nothing here', 'This folder is empty.'),
      );
      return nodes;
    }

    if (showingResults) {
      nodes.push(h('div.section-title', null, `${level.resultsTotal ?? items.length} results for “${level.query}”`));
    }

    const numbered = !showingResults && items.every((item) => item.type === 'song');
    nodes.push(h('div.rows', null, items.map((item, index) => this.itemRow(item, level, numbered ? index + 1 : null))));

    const remaining = (level.total ?? 0) - level.items.length;
    if (!showingResults && remaining > 0) {
      nodes.push(
        h(
          'div',
          { style: { padding: '14px 16px' } },
          h(
            'button.btn.btn--ghost.btn--block',
            { type: 'button', onclick: () => this.load(level, { append: true }) },
            `Load ${Math.min(remaining, PAGE_SIZE)} more`,
          ),
        ),
      );
    }
    return nodes;
  }

  renderSearchBar(level) {
    const input = h('input', {
      type: 'search',
      placeholder: `Search ${level.title}`,
      value: level.query ?? '',
      'aria-label': `Search ${level.title}`,
    });
    const select = level.criteria.length > 1
      ? h(
          'select',
          {
            'aria-label': 'Search for',
            onchange: () => run(),
          },
          level.criteria.map((criteria) =>
            h('option', { value: criteria.scid, selected: criteria.scid === level.scid }, criteria.name),
          ),
        )
      : null;

    const run = () => this.runSearch(level, input.value, select ? Number(select.value) : level.criteria[0]?.scid);
    const debounced = debounce(run, 350);

    input.addEventListener('input', debounced);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        debounced.cancel();
        run();
      }
      if (event.key === 'Escape') {
        input.value = '';
        run();
      }
    });

    return h(
      'div.searchbar',
      null,
      h('div.searchbar__input', null, icon('search'), input),
      select,
      level.results
        ? h(
            'button.iconbtn',
            {
              type: 'button',
              'aria-label': 'Clear search',
              onclick: () => this.runSearch(level, '', level.scid),
            },
            icon('close'),
          )
        : null,
    );
  }

  renderHero(level) {
    const item = level.container;
    const playable = item.playable !== false;
    return h(
      'div.hero',
      null,
      h(
        'div.hero__top',
        null,
        artwork(item.image, item.name, 'hero__art', item.name),
        h(
          'div.hero__meta',
          null,
          h('div.hero__kind', null, describeType(item.type)),
          h('div.hero__title', null, item.name),
          item.artist ? h('div.hero__sub', null, item.artist) : null,
          level.total ? h('div.hero__sub', null, `${level.total} items`) : null,
        ),
      ),
      h(
        'div.hero__actions',
        null,
        playable
          ? h(
              'button.btn.btn--primary',
              { type: 'button', onclick: () => playItem(item, 'PLAY_NOW', { containerCid: level.cid }) },
              icon('play'),
              'Play',
            )
          : null,
        playable
          ? h(
              'button.btn',
              { type: 'button', onclick: () => playItem(item, 'ADD_TO_END', { containerCid: level.cid }) },
              icon('addEnd'),
              'Add to Queue',
            )
          : null,
        h(
          'button.btn.btn--ghost',
          {
            type: 'button',
            'aria-label': 'More options',
            onclick: () => openItemActions(item, { containerCid: level.cid }),
          },
          icon('more'),
        ),
      ),
    );
  }

  itemRow(item, level, index) {
    const isContainer = item.container;
    const isFavorite = level.sid === FAVORITES_SID;
    const context = {
      containerCid: level.cid,
      isFavorite,
      onChanged: () => this.load(level),
    };

    const activate = () => {
      if (isContainer) return this.openContainer(item, level);
      if (item.playable) return playItem(item, 'PLAY_NOW', context);
      return undefined;
    };

    const row = h(
      'div.row',
      { role: 'button', tabindex: '0' },
      index ? h('span.row__index', null, index) : artwork(item.image, item.name, `row__art${item.type === 'artist' ? ' row__art--round' : ''}`, item.name),
      (() => {
        const subtitle = subtitleFor(item, level);
        return h(
          'div.row__body',
          null,
          h('div.row__title', null, item.name),
          subtitle ? h('div.row__sub', null, subtitle) : null,
        );
      })(),
      h(
        'span.row__meta',
        null,
        h('span', { class: 'row__eq' }),
        isContainer ? icon('chevron') : null,
        item.playable || isContainer
          ? h(
              'button.iconbtn',
              {
                type: 'button',
                'aria-label': `Options for ${item.name}`,
                onclick: (event) => {
                  event.stopPropagation();
                  openItemActions(item, context);
                },
              },
              icon('more'),
            )
          : null,
      ),
    );

    row.addEventListener('click', activate);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate();
      }
    });

    if (item.mid) {
      const list = this.rowNodes.get(item.mid) ?? [];
      list.push(row);
      this.rowNodes.set(item.mid, list);
    }
    return row;
  }

  /** Mark the row matching the target room's current track. */
  applyNowPlaying() {
    const player = targetPlayer();
    const mid = player?.nowPlaying?.mid;
    for (const [key, rows] of this.rowNodes) {
      const active = Boolean(mid) && key === mid;
      for (const row of rows) {
        row.classList.toggle('row--active', active);
        const slot = row.querySelector('.row__eq');
        if (!slot) continue;
        if (active) {
          slot.className = `row__eq equalizer${player.state === 'play' ? '' : ' equalizer--paused'}`;
          if (!slot.childElementCount) slot.append(h('i'), h('i'), h('i'));
        } else {
          slot.className = 'row__eq';
          slot.replaceChildren();
        }
      }
    }
  }

  promptForUrl() {
    const input = h('input', {
      type: 'url',
      placeholder: 'http://stream.example.com/live.mp3',
      style: {
        width: '100%',
        padding: '11px 12px',
        borderRadius: '10px',
        background: 'var(--bg-raised)',
        border: '1px solid var(--line)',
        outline: 'none',
      },
    });
    const sheet = showSheet({
      title: 'Play a stream URL',
      subtitle: targetPlayer()?.name ?? '',
      items: [
        {
          label: 'Play',
          icon: 'play',
          onSelect: async () => {
            const player = targetPlayer();
            if (!player || !input.value.trim()) return;
            await attempt(() => api.playUrl(player.pid, input.value.trim()), { success: 'Streaming URL' });
            setTab('now');
          },
        },
      ],
    });
    const head = sheet.querySelector('.sheet__grip');
    head.after(h('div', { style: { padding: '6px 18px 12px' } }, input));
    input.focus();
  }
}

/**
 * Row subtitle, minus whatever context the current level already provides —
 * inside an album every track would otherwise repeat "Artist — Album".
 */
function subtitleFor(item, level) {
  const container = level?.container;
  if (item.type === 'song') {
    const parts = [];
    if (item.artist && item.artist !== container?.artist) parts.push(item.artist);
    if (item.album && container?.type !== 'album') parts.push(item.album);
    return parts.join(' — ');
  }
  if (item.type === 'station') return item.artist || 'Station';
  if (item.type === 'album') return item.artist || 'Album';
  return describeType(item.type);
}

function loading() {
  return h('div.loading', null, h('div.spinner', { role: 'status', 'aria-label': 'Loading' }));
}

function empty(title, message) {
  return h('div.empty', null, h('div.empty__title', null, title), message);
}

function errorState(message, retry) {
  return h(
    'div.empty',
    null,
    h('div.empty__title', null, 'Could not load'),
    message,
    h(
      'div',
      { style: { marginTop: '14px' } },
      h('button.btn.btn--ghost', { type: 'button', onclick: retry }, icon('refresh'), 'Try again'),
    ),
  );
}
