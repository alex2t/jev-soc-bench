/**
 * Inline SVG charts. Colour follows the series (model), fixed by its position in the view; every
 * mark carries a <title> tooltip, and every chart has a legend or direct labels.
 */

import { el, pct, ms } from './dom.js';

const NS = 'http://www.w3.org/2000/svg';
const DIFFICULTIES = ['clear', 'ambiguous', 'adversarial'];
const ACTIONS = [
  ['auto_quarantine', 'Auto-quarantined', 'act-1'],
  ['auto_close', 'Auto-closed', 'act-2'],
  ['analyst_review', 'Sent to an analyst', 'act-3'],
];

function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  node.append(...children.flat(Infinity).filter(c => c != null));
  return node;
}

const tip = text => svg('title', {}, text);
const label = (x, y, text, attrs = {}) => svg('text', { x, y, ...attrs }, text);

function legend(view, suffix = () => '') {
  return el('ul', { class: 'legend' }, view.series.map((s, i) =>
    el('li', {}, el('span', { style: { '--swatch': `var(--series-${i + 1})` } }), `${s.name}${suffix(s)}`)));
}

/** A bar growing up from the baseline with 4px rounded top corners. */
function columnPath(x, y, w, h) {
  const r = Math.min(4, h, w / 2);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

/** Horizontal gridlines with percentage ticks for a 0..1 y axis. */
function percentAxis(g, { left, right, top, height }) {
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    const y = top + height * (1 - v);
    g.append(svg('line', { class: v === 0 ? 'axis' : 'grid', x1: left, x2: right, y1: y, y2: y }),
      label(left - 6, y + 4, `${v * 100}%`, { 'text-anchor': 'end' }));
  }
}

export function drawDifficulty(view) {
  const W = 720, H = 260, left = 44, right = W - 8, top = 16, height = 200;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Queue accuracy by difficulty' });
  percentAxis(root, { left, right, top, height });
  const groupW = (right - left) / DIFFICULTIES.length;
  const barW = Math.min(24, (groupW - 40) / view.series.length - 2);
  DIFFICULTIES.forEach((d, gi) => {
    const n = view.series[0]?.summary.queue.byDifficulty[d]?.n;
    const cx = left + groupW * (gi + 0.5);
    root.append(label(cx, top + height + 20, `${d} (n=${n ?? 0} calls)`, { 'text-anchor': 'middle' }));
    const x0 = cx - (view.series.length * (barW + 2) - 2) / 2;
    view.series.forEach((s, i) => {
      const v = s.summary.queue.byDifficulty[d];
      if (v?.value == null) return;
      const h = height * v.value;
      const x = x0 + i * (barW + 2);
      root.append(
        svg('path', { class: `s${i + 1}`, d: columnPath(x, top + height - h, barW, h) }, tip(`${s.name}, ${d}: ${pct(v.value)} of ${v.n} calls`)),
        label(x + barW / 2, top + height - h - 4, `${Math.round(v.value * 100)}`, { 'text-anchor': 'middle', class: 'value' }));
    });
  });
  document.getElementById('difficulty').replaceChildren(legend(view), root);
}

function niceMax(v) {
  const step = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / step) * step;
}

export function drawLatency(view) {
  const rows = view.series.flatMap((s, i) => {
    const ups = [...new Set(s.records.filter(r => r.status === 'ok').map(r => r.upstreamProvider ?? 'unknown'))].sort();
    return ups.map(u => ({ s, i, name: `${s.name} via ${u}`, values: s.records.filter(r => r.status === 'ok' && (r.upstreamProvider ?? 'unknown') === u).map(r => r.latencyMs) }));
  });
  const max = niceMax(Math.max(...rows.flatMap(r => r.values)));
  const W = 720, left = 170, right = W - 32, rowH = 44, top = 8;
  const H = top + rows.length * rowH + 30;
  const x = v => left + (right - left) * (v / max);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Latency per call' });
  for (let t = 0; t <= 4; t++) {
    const v = (max / 4) * t;
    root.append(svg('line', { class: t ? 'grid' : 'axis', x1: x(v), x2: x(v), y1: top, y2: H - 26 }),
      label(x(v), H - 10, ms(v), { 'text-anchor': 'middle' }));
  }
  rows.forEach((r, ri) => {
    const cy = top + ri * rowH + rowH / 2;
    const sorted = [...r.values].sort((a, b) => a - b);
    const median = sorted[Math.ceil(sorted.length / 2) - 1];
    root.append(label(left - 8, cy + 4, `${r.name} (n=${r.values.length})`, { 'text-anchor': 'end' }));
    r.values.forEach((v, k) => root.append(svg('circle', {
      class: `dot s${r.i + 1}`, cx: x(v), cy: cy + ((k * 7) % 15) - 7, r: 4, 'fill-opacity': 0.75,
    }, tip(`${r.name}: ${ms(v)}`))));
    root.append(svg('line', { class: 'median', x1: x(median), x2: x(median), y1: cy - 14, y2: cy + 14 }, tip(`${r.name} median ${ms(median)}`)));
  });
  document.getElementById('latency').replaceChildren(legend(view), root);
}

/** A reliability diagram: predicted (x) against observed (y), with the diagonal and bucket counts. */
function reliability(title, lines) {
  const W = 360, H = 320, left = 44, right = W - 12, top = 12, height = 250;
  const x = v => left + (right - left) * v;
  const y = v => top + height * (1 - v);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': title });
  percentAxis(root, { left, right, top, height });
  for (const v of [0, 0.5, 1]) root.append(label(x(v), top + height + 18, `${v * 100}%`, { 'text-anchor': 'middle' }));
  root.append(svg('line', { class: 'diag', x1: x(0), y1: y(0), x2: x(1), y2: y(1) }));
  for (const { cls, name, points } of lines) {
    if (points.length > 1) root.append(svg('polyline', { class: `line ${cls}`, points: points.map(p => `${x(p.x)},${y(p.y)}`).join(' ') }));
    for (const p of points) {
      root.append(svg('circle', { class: `dot ${cls}`, cx: x(p.x), cy: y(p.y), r: 5 },
        tip(`${name}: predicted ${pct(p.x)}, observed ${pct(p.y)}, n=${p.n}`)));
    }
  }
  return root;
}

export function drawCalibration(view) {
  const confident = view.series.map((s, i) => ({ s, i })).filter(({ s }) => s.summary.calibration.queue);
  const queueLines = confident.map(({ s, i }) => ({
    cls: `s${i + 1}`, name: s.name,
    points: s.summary.calibration.queue.buckets.filter(b => b.n).map(b => ({ x: b.meanConfidence, y: b.accuracy, n: b.n })),
  }));
  const quarantineLines = view.series.map((s, i) => ({
    cls: `s${i + 1}`, name: s.name,
    points: s.summary.noulReliability.buckets.filter(b => b.n).map(b => ({ x: b.meanPredicted, y: b.observedRate, n: b.n })),
  }));
  const bucketTable = confident.map(({ s }) => el('table', {},
    el('thead', {}, el('tr', {}, el('th', {}, `${s.name} confidence`), el('th', {}, 'calls'), el('th', {}, 'correct'))),
    el('tbody', {}, s.summary.calibration.queue.buckets.map(b => el('tr', {},
      el('td', {}, `${b.lo * 100}-${b.hi * 100}%`), el('td', {}, String(b.n)), el('td', {}, b.n ? pct(b.accuracy) : '-'))))));
  document.getElementById('calibration').replaceChildren(el('div', { class: 'charts-row' },
    el('div', {},
      el('h3', {}, 'Queue: confidence vs accuracy'),
      el('p', { class: 'note' }, confident.length
        ? 'Only Jev returns a confidence. Points on the dashed diagonal are perfectly calibrated; hover a point for its bucket count.'
        : 'No model in this view returns a confidence.'),
      reliability('Queue confidence against observed accuracy', queueLines), bucketTable),
    el('div', {},
      el('h3', {}, 'Quarantine: predicted probability vs observed rate'),
      el('p', { class: 'note' }, 'Share of alerts labelled "quarantine" in each decile of the answered probability. LLM probabilities are self-reported.'),
      legend(view, s => (s.provider === 'jev' ? '' : ' (self-reported)')),
      reliability('Quarantine probability against observed rate', quarantineLines))));
}

export function drawAutomation(view) {
  const W = 720, left = 120, right = W - 8, rowH = 40, top = 4;
  const H = top + view.series.length * rowH;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Automation coverage' });
  view.series.forEach((s, i) => {
    const a = s.summary.automation;
    const y = top + i * rowH + 6;
    root.append(label(left - 8, y + 18, s.name, { 'text-anchor': 'end' }));
    let x = left;
    for (const [key, name, cls] of ACTIONS) {
      const w = (right - left) * (a[key].value ?? 0);
      if (w <= 0) continue;
      root.append(svg('rect', { class: cls, x, y, width: Math.max(0, w - 2), height: 26, rx: 2 },
        tip(`${s.name}: ${name} ${a[key].count} of ${a.n} calls (${pct(a[key].value)})`)));
      if (w > 60) root.append(label(x + 6, y + 18, `${Math.round(a[key].value * 100)}%`, { class: `${cls}-ink` }));
      x += w;
    }
  });
  const facts = el('table', {},
    el('thead', {}, el('tr', {}, ['Model', 'Auto actions correct', 'Threats auto-closed', 'Injection followed'].map(h => el('th', {}, h)))),
    el('tbody', {}, view.series.map(s => {
      const a = s.summary.automation;
      const inj = s.summary.injection;
      return el('tr', {},
        el('td', {}, s.name),
        el('td', {}, `${pct(a.autoActionAccuracy.value)} of ${a.autoActionAccuracy.n}`),
        el('td', { class: a.threatsAutoClosed.count ? 'wrong' : 'ok' }, String(a.threatsAutoClosed.count)),
        el('td', { class: inj.followed ? 'wrong' : 'ok' }, inj.n ? `${inj.followed}/${inj.n}` : '-'));
    })));
  document.getElementById('automation').replaceChildren(
    el('ul', { class: 'legend' }, ACTIONS.map(([, name, cls]) => el('li', {}, el('span', { class: `sw-${cls}` }), name))),
    root,
    el('p', { class: 'note' }, 'The LLMs return no confidence, so the "low confidence goes to an analyst" rule never applies to them; '
      + 'their quarantine probabilities are self-reported. The two automation rates are therefore not the same policy applied to equal inputs.'),
    facts);
}
