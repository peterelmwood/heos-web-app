/** Inline SVG icons (Feather-ish, 24×24, currentColor). */

import { svg } from './dom.js';

const wrap = (body, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" ${extra}>${body}</svg>`;

const PATHS = {
  back: '<polyline points="15 18 9 12 15 6"/>',
  chevron: '<polyline points="9 18 15 12 9 6"/>',
  more: '<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.7" y2="16.7"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  speaker:
    '<rect x="5" y="2.5" width="14" height="19" rx="3"/><circle cx="12" cy="15" r="3.2"/><circle cx="12" cy="7" r="1.2"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  disc: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.6"/>',
  play: '<polygon points="6 3.5 20.5 12 6 20.5" fill="currentColor" stroke-linejoin="round"/>',
  pause: '<rect x="6.5" y="4" width="4" height="16" rx="1.2" fill="currentColor"/><rect x="13.5" y="4" width="4" height="16" rx="1.2" fill="currentColor"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>',
  next: '<polygon points="5 4 15 12 5 20" fill="currentColor"/><rect x="17" y="4" width="2.6" height="16" rx="1.2" fill="currentColor"/>',
  previous: '<polygon points="19 4 9 12 19 20" fill="currentColor"/><rect x="4.4" y="4" width="2.6" height="16" rx="1.2" fill="currentColor"/>',
  shuffle: '<polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/>',
  repeat: '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  repeatOne:
    '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><text x="12" y="15.5" font-size="8" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none">1</text>',
  volume: '<polygon points="10 6 6 9.5 3 9.5 3 14.5 6 14.5 10 18" fill="currentColor" stroke-linejoin="round"/><path d="M15 9.2a4 4 0 0 1 0 5.6"/><path d="M17.8 6.4a8 8 0 0 1 0 11.2"/>',
  volumeMute: '<polygon points="10 6 6 9.5 3 9.5 3 14.5 6 14.5 10 18" fill="currentColor" stroke-linejoin="round"/><line x1="15" y1="9.5" x2="21" y2="14.5"/><line x1="21" y1="9.5" x2="15" y2="14.5"/>',
  queue: '<line x1="3" y1="6" x2="15" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="11" y2="18"/><polygon points="17 14 22 17 17 20" fill="currentColor"/>',
  playNext: '<line x1="3" y1="6" x2="14" y2="6"/><line x1="3" y1="12" x2="14" y2="12"/><line x1="3" y1="18" x2="10" y2="18"/><polyline points="18 9 21 12 18 15"/>',
  addEnd: '<line x1="3" y1="6" x2="15" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="15" y2="18"/><line x1="19.5" y1="8.5" x2="19.5" y2="15.5"/><line x1="16" y1="12" x2="23" y2="12"/>',
  replace: '<polyline points="21 3 21 8 16 8"/><path d="M21 8A9 9 0 0 0 5.6 6.6"/><polyline points="3 21 3 16 8 16"/><path d="M3 16a9 9 0 0 0 15.4 1.4"/>',
  star: '<polygon points="12 3 14.8 9.1 21.5 9.9 16.6 14.5 17.9 21.1 12 17.9 6.1 21.1 7.4 14.5 2.5 9.9 9.2 9.1"/>',
  starOff: '<polygon points="12 3 14.8 9.1 21.5 9.9 16.6 14.5 17.9 21.1 12 17.9 6.1 21.1 7.4 14.5 2.5 9.9 9.2 9.1"/><line x1="3" y1="3" x2="21" y2="21"/>',
  trash: '<polyline points="3 6 21 6"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/>',
  group: '<circle cx="8.5" cy="9" r="3"/><circle cx="17" cy="10" r="2.4"/><path d="M2.5 19a6 6 0 0 1 12 0"/><path d="M15 19a5 5 0 0 1 6.5-4"/>',
  refresh: '<polyline points="21 4 21 10 15 10"/><path d="M20.2 14a8.2 8.2 0 1 1-1.8-8.4L21 8"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.1"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.1"/>',
  info: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16.5"/><circle cx="12" cy="7.8" r="1"/>',
  wifi: '<path d="M2 8.5a15 15 0 0 1 20 0"/><path d="M5.5 12.5a10 10 0 0 1 13 0"/><path d="M9 16.4a5 5 0 0 1 6 0"/><circle cx="12" cy="20" r="1"/>',
  aux: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.4"/>',
  folder: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2.5h8.5A1.5 1.5 0 0 1 21 10v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z"/>',
  radio: '<circle cx="12" cy="12" r="2.2"/><path d="M7.8 16.2a6 6 0 0 1 0-8.4"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4"/><path d="M4.9 19.1a10 10 0 0 1 0-14.2"/><path d="M19.1 4.9a10 10 0 0 1 0 14.2"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  check: '<polyline points="4 12.5 9.5 18 20 6"/>',
};

/** @returns {SVGElement} */
export function icon(name, extra = '') {
  const body = PATHS[name] ?? PATHS.disc;
  return svg(wrap(body, extra));
}
