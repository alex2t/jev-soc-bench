/** DOM and number formatting helpers shared by the page modules; text is never parsed as HTML. */

/** Create an element; strings and nodes in `children` are appended as text or nodes. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') Object.entries(v).forEach(([p, x]) => node.style.setProperty(p, x));
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.flat(Infinity).filter(c => c != null && c !== false));
  return node;
}

export const pct = v => (v == null ? 'unavailable' : `${(v * 100).toFixed(1)}%`);
export const ms = v => (v == null ? 'unavailable' : `${Math.round(v).toLocaleString('en-US')} ms`);
export const usd = v => (v == null ? 'unavailable' : `$${v < 0.1 ? v.toFixed(3) : v.toFixed(2)}`);
export const swatch = i => `var(--series-${i + 1})`;
