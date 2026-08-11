/** Tiny DOM helpers — enough structure to build the UI without a framework. */

/**
 * Create an element.
 *
 * @param {string} tag tag name, optionally with `.class` suffixes
 * @param {object|null} [props] attributes, `on*` handlers, `dataset`, `style`
 * @param {...(Node|string|null|undefined|Array)} children
 */
export function h(tag, props, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');

  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = [el.className, value].filter(Boolean).join(' ');
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'html') el.innerHTML = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }

  append(el, children);
  return el;
}

export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

/** Replace an element's children in one shot. */
export function fill(parent, ...children) {
  parent.replaceChildren();
  append(parent, children);
  return parent;
}

/** Parse an inline SVG string into a node. */
export function svg(markup) {
  const template = document.createElement('template');
  template.innerHTML = markup.trim();
  return template.content.firstElementChild;
}

/** `mm:ss` (or `h:mm:ss`) from milliseconds. */
export function formatTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value) => String(value).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export function debounce(fn, wait = 300) {
  let timer;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

/** Fallback artwork for items a source did not give an image for. */
export function artFor(name, size = 128) {
  return `/api/art/${encodeURIComponent(name || 'Music')}.svg?size=${size}`;
}

/**
 * Image element that quietly swaps to generated art when the source's own
 * artwork URL fails (offline, expired CDN token, http-in-https, …).
 */
export function artwork(src, alt, className, fallbackSeed) {
  const img = h('img', {
    class: className,
    alt: alt ?? '',
    loading: 'lazy',
    decoding: 'async',
    src: src || artFor(fallbackSeed ?? alt),
  });
  img.addEventListener('error', () => {
    const fallback = artFor(fallbackSeed ?? alt);
    if (img.src.endsWith(fallback)) return;
    img.src = fallback;
  });
  return img;
}
