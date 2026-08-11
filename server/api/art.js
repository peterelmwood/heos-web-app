/**
 * Generated placeholder cover art.
 *
 * The simulator has no real artwork and the app should work with no internet
 * access, so album/station images are deterministic SVG gradients derived from
 * the item's name. Real devices return their own image URLs and never hit this.
 */

const PALETTES = [
  ['#0f2027', '#2c5364'],
  ['#42275a', '#734b6d'],
  ['#1f4037', '#99f2c8'],
  ['#4b1248', '#f0c27b'],
  ['#232526', '#414345'],
  ['#16222a', '#3a6073'],
  ['#5f2c82', '#49a09d'],
  ['#833ab4', '#fd1d1d'],
  ['#004e92', '#000428'],
  ['#3a1c71', '#d76d77'],
  ['#0b486b', '#f56217'],
  ['#136a8a', '#267871'],
];

function hash(text) {
  let value = 0;
  for (let i = 0; i < text.length; i += 1) {
    value = (value * 31 + text.charCodeAt(i)) >>> 0;
  }
  return value;
}

function initials(text) {
  const words = text.replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return '♪';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

const escapeXml = (text) =>
  text.replace(/[<>&'"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[char]));

/** @returns {string} an SVG document for the given seed text */
export function renderArt(seed, size = 512) {
  const digest = hash(seed);
  const [from, to] = PALETTES[digest % PALETTES.length];
  const angle = digest % 360;
  const label = escapeXml(initials(seed));
  const ring = 0.22 * size + (digest % 40);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${escapeXml(seed)}">
  <defs>
    <linearGradient id="g" gradientTransform="rotate(${angle} 0.5 0.5)">
      <stop offset="0%" stop-color="${from}"/>
      <stop offset="100%" stop-color="${to}"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" fill="url(#g)"/>
  <circle cx="${size * 0.78}" cy="${size * 0.24}" r="${ring}" fill="#ffffff" opacity="0.07"/>
  <circle cx="${size * 0.18}" cy="${size * 0.82}" r="${ring * 0.8}" fill="#000000" opacity="0.10"/>
  <text x="50%" y="50%" dy="0.35em" text-anchor="middle" fill="#ffffff" fill-opacity="0.9"
        font-family="Inter, Helvetica, Arial, sans-serif" font-size="${size * 0.3}" font-weight="600">${label}</text>
</svg>`;
}
