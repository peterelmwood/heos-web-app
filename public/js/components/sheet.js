/** Bottom action sheet, the HEOS app's primary way of offering choices. */

import { h, artwork } from '../dom.js';
import { icon } from '../icons.js';

let openSheet = null;

/**
 * @param {object} options
 * @param {string} [options.title]
 * @param {string} [options.subtitle]
 * @param {string} [options.image]
 * @param {string} [options.note] small print under the header
 * @param {Array<{label: string, icon?: string, danger?: boolean, active?: boolean, onSelect?: Function} | 'divider'>} options.items
 */
export function showSheet({ title, subtitle, image, note, items }) {
  closeSheet();

  const scrim = h('div.scrim', {
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title ?? 'Options',
    onclick: (event) => {
      if (event.target === scrim) closeSheet();
    },
  });

  const sheet = h('div.sheet');
  sheet.append(h('div.sheet__grip'));

  if (title) {
    sheet.append(
      h(
        'div.sheet__head',
        null,
        image !== undefined ? artwork(image, title, 'sheet__art', title) : null,
        h('div', { style: { minWidth: 0 } }, h('div.sheet__title', null, title), subtitle ? h('div.sheet__sub', null, subtitle) : null),
      ),
    );
  }
  if (note) sheet.append(h('div.sheet__note', null, note));

  for (const item of items) {
    if (item === 'divider') {
      sheet.append(h('div', { style: { height: '1px', background: 'var(--line-soft)', margin: '6px 0' } }));
      continue;
    }
    const button = h(
      'button.sheet__item',
      {
        type: 'button',
        class: [item.danger ? 'sheet__item--danger' : '', item.active ? 'sheet__item--on' : ''].filter(Boolean).join(' '),
        onclick: async () => {
          closeSheet();
          await item.onSelect?.();
        },
      },
      item.icon ? icon(item.icon) : h('span', { style: { width: '20px' } }),
      h('span', null, item.label),
      item.active ? h('span', { style: { marginLeft: 'auto' } }, icon('check')) : null,
    );
    sheet.append(button);
  }

  scrim.append(sheet);
  document.body.append(scrim);
  openSheet = scrim;
  sheet.querySelector('.sheet__item')?.focus?.();
  document.addEventListener('keydown', onKeydown);
  return scrim;
}

function onKeydown(event) {
  if (event.key === 'Escape') closeSheet();
}

export function closeSheet() {
  document.removeEventListener('keydown', onKeydown);
  openSheet?.remove();
  openSheet = null;
}
