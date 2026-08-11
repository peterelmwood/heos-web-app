/** Transient confirmations ("Added to queue") and error surfacing. */

import { h } from '../dom.js';

let container = null;

function ensureContainer() {
  if (!container) {
    container = h('div.toasts', { 'aria-live': 'polite' });
    document.body.append(container);
  }
  return container;
}

export function toast(message, { error = false, duration = 2600 } = {}) {
  const node = h('div.toast', { class: error ? 'toast--error' : '' }, message);
  ensureContainer().append(node);
  setTimeout(() => {
    node.style.transition = 'opacity 220ms ease';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 240);
  }, duration);
  return node;
}

/** Run an action, showing its error as a toast rather than throwing. */
export async function attempt(action, { success, failure = 'Something went wrong' } = {}) {
  try {
    const result = await action();
    if (success) toast(success);
    return result;
  } catch (err) {
    toast(err.message || failure, { error: true });
    return null;
  }
}
