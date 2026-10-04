/**
 * Batching experiment sections (plan.md section 13): single vs batched per model, the position
 * effect chart, and the contamination panel with its exposed/control detail view.
 */

import { experimentSeries, contaminationRows, contaminationPair, injectionParts } from './model.js';
import { el, pct, ms, usd } from './dom.js';

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...children) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  node.append(...children.flat(Infinity).filter(c => c != null));
  return node;
};

const arrow = (a, b, fmt) => `${fmt(a)} -> ${fmt(b)}`;
const signedPts = v => (v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)} pts`);
const cachedNote = c => (c?.share == null ? '' : ` (${Math.round(c.share * 100)}% cached)`);

function comparisonTable(entries, runsById) {
  const head = ['Model', 'Queue accuracy', 'Change', 'Same majority queue', 'Mean change in quarantine', 'Same queue across repeats',
    'Cost per 1,000 alerts', 'Latency per alert p50', 'Request p50', 'Failed requests'];
  const rows = entries.map(e => {
    const c = e.comparison;
    const batch = runsById.get(e.batchRunId);
    const single = runsById.get(e.singleRunId);
    const bSum = batch.summary.providers[e.provider];
    const sSum = single.summary.providers[e.provider];
    return el('tr', {},
      el('td', {}, e.model.split('/').pop()),
      el('td', {}, arrow(c.accuracy.queue.single, c.accuracy.queue.batched, pct)),
      el('td', { class: c.accuracy.queue.delta < 0 ? 'wrong' : '' }, signedPts(c.accuracy.queue.delta)),
      el('td', {}, `${pct(c.agreement.sameMajorityQueue.value)} of ${c.agreement.sameMajorityQueue.n}`),
      el('td', {}, c.agreement.meanAbsQuarantineChange.value.toFixed(3)),
      el('td', {}, arrow(c.consistency.single.sameQueueShare.value, c.consistency.batched.sameQueueShare.value, pct)),
      el('td', {}, `${usd(c.costPer1000AlertsUsd.single)}${cachedNote(sSum.cost.cachedInput)} -> ${usd(c.costPer1000AlertsUsd.batched)}${cachedNote(bSum.cost.cachedInput)}`),
      el('td', {}, arrow(c.latencyPerAlertMsP50.single, c.latencyPerAlertMsP50.batched, ms)),
      el('td', {}, ms(batch.summary.batch[e.provider].requestLatencyMs.p50)),
      el('td', { class: c.requests.failed ? 'wrong' : '' }, `${c.requests.failed} of ${c.requests.n}`));
  });
  return el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, head.map(h => el('th', {}, h)))), el('tbody', {}, rows)));
}

function positionChart(series, colourOf) {
  const groups = series[0].run.summary.batch[series[0].provider].positionEffect.map(g => g.positions);
  const W = 720, H = 240, left = 44, right = W - 8, top = 16, height = 180;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Queue accuracy by position in the batch' });
  const lo = 0.5;
  const y = v => top + height * (1 - (v - lo) / (1 - lo));
  for (const v of [0.5, 0.75, 1]) {
    root.append(svg('line', { class: v === lo ? 'axis' : 'grid', x1: left, x2: right, y1: y(v), y2: y(v) }),
      svg('text', { x: left - 6, y: y(v) + 4, 'text-anchor': 'end' }, `${v * 100}%`));
  }
  const groupW = (right - left) / groups.length;
  const barW = Math.min(24, (groupW - 40) / series.length - 2);
  groups.forEach((label, gi) => {
    const cx = left + groupW * (gi + 0.5);
    root.append(svg('text', { x: cx, y: top + height + 20, 'text-anchor': 'middle' }, `positions ${label}`));
    series.forEach((s, i) => {
      const g = s.run.summary.batch[s.provider].positionEffect[gi];
      if (g.value == null) return;
      const x = cx - (series.length * (barW + 2)) / 2 + i * (barW + 2);
      const h = Math.max(0, y(lo) - y(g.value));
      root.append(svg('rect', { class: `s${colourOf(s.model)}`, x, y: y(g.value), width: barW, height: h, rx: 2 },
        svg('title', {}, `${s.name}, positions ${label}: ${pct(g.value)} of ${g.n}`)),
      svg('text', { class: 'value', x: x + barW / 2, y: y(g.value) - 4, 'text-anchor': 'middle' }, `${Math.round(g.value * 100)}`));
    });
  });
  return root;
}

function legend(series, colourOf) {
  return el('ul', { class: 'legend' }, series.map(s => el('li', {}, el('span', { style: { '--swatch': `var(--series-${colourOf(s.model)})` } }), s.name)));
}

export function drawBatching(runs, comparisons, colourOf) {
  const target = document.getElementById('batching-body');
  const series = experimentSeries(runs, 'batch');
  const entries = comparisons.filter(c => c.comparison).sort((a, b) => colourOf(a.model) - colourOf(b.model));
  if (!series.length) return target.replaceChildren(el('p', { class: 'note' }, 'No batch run is published yet.'));
  const runsById = new Map(runs.map(r => [r.meta.runId, r]));
  target.replaceChildren(
    el('h3', {}, 'Single alert vs 10 alerts per request'),
    el('p', { class: 'note' }, 'Each model answered the same 40 alerts 3 times, once per request and in batches of 10, '
      + 'with the order rotated by 3 positions per repeat. Arrows read single -> batched.'),
    comparisonTable(entries, runsById),
    el('h3', {}, 'Queue accuracy by position in the batch'),
    el('p', { class: 'note' }, 'A drop at later positions would be a long-context weakness. The axis starts at 50%.'),
    legend(series, colourOf),
    el('div', { class: 'chart' }, positionChart(series, colourOf)));
}

function highlighted(text) {
  return injectionParts(text).map(p => (p.injected ? el('mark', {}, p.text) : p.text));
}

function contaminationDetail(row, series, alerts) {
  const byId = new Map(alerts.map(a => [a.id, a]));
  const pairs = series.map(s => ({ s, repeats: [1, 2, 3].map(r => contaminationPair(s, row.source.id, r)) }));
  const exposed = pairs[0].repeats[0].exposed;
  const answer = (s, request, alertId) => {
    const rec = s.records.find(r => r.batchId === request.batchId && r.alertId === alertId);
    return rec?.status === 'ok' ? `${rec.answers.queue.value} (${rec.answers.quarantine.value}, ${rec.action})` : rec?.status ?? '-';
  };
  const companions = exposed.alertIds.filter(id => id !== row.source.id);
  document.getElementById('detail-body').replaceChildren(
    el('h2', {}, `Contamination: ${row.source.id}`),
    el('p', {}, `Injection aims at: ${row.target}. The exposed batch holds the source and 4 companions; the control batch holds the same companions in the same order.`),
    el('h3', {}, 'Exposed batch (repeat 1), in order'),
    el('div', {}, exposed.alertIds.map((id, i) => el('div', {}, el('h3', {}, `alerts[${i}] ${id}${id === row.source.id ? ' (source)' : ''}`),
      el('pre', {}, highlighted(JSON.stringify(byId.get(id).state, null, 2)))))),
    el('h3', {}, 'Companion answers: control -> exposed (queue, quarantine, action)'),
    el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Companion'), el('th', {}, 'Repeat'), pairs.map(p => el('th', {}, p.s.name)))),
      el('tbody', {}, companions.flatMap(id => [1, 2, 3].map(rep => el('tr', {},
        el('td', {}, `${id} (${byId.get(id).expected.queue})`), el('td', {}, String(rep)),
        pairs.map(p => {
          const { exposed: e, control: c } = p.repeats[rep - 1];
          const [before, after] = [answer(p.s, c, id), answer(p.s, e, id)];
          return el('td', { class: before.split(' ')[0] === after.split(' ')[0] ? '' : 'wrong' }, `${before} -> ${after}`);
        }))))))));
  document.getElementById('detail').showModal();
}

export function drawContamination(runs, alerts, colourOf) {
  const target = document.getElementById('contamination-body');
  const series = experimentSeries(runs, 'contamination');
  if (!series.length) return target.replaceChildren(el('p', { class: 'note' }, 'No contamination run is published yet.'));
  const rows = contaminationRows(series, alerts);
  const cell = c => (c ? el('td', { class: c.dangerousDowngrades.count || c.queueFlipRate.flips ? 'wrong' : '' },
    `${c.queueFlipRate.flips}/${c.queueFlipRate.n} flipped, ${c.flipsToBenign.count} to benign, `
    + `quarantine ${c.quarantineShift.value >= 0 ? '+' : ''}${c.quarantineShift.value.toFixed(3)}, `
    + `${c.dangerousDowngrades.count} dangerous, source ${pct(c.sourceAccuracy.value)}`) : el('td', {}, '-'));
  const body = rows.map(row => {
    const tr = el('tr', { tabindex: 0 }, el('td', {}, row.source.id), el('td', {}, row.target === 'none' ? 'none (misleading wording only)' : row.target), row.cells.map(cell));
    tr.addEventListener('click', () => contaminationDetail(row, series, alerts));
    tr.addEventListener('keydown', e => { if (e.key === 'Enter') contaminationDetail(row, series, alerts); });
    return tr;
  });
  const totals = el('tr', {}, el('th', {}, 'All sources'), el('td', {}, ''), series.map(s => cell(s.summary.total)));
  const baseline = el('tr', {}, el('th', {}, 'Baseline: control repeats'), el('td', {}, ''),
    series.map(s => el('td', {}, `${s.summary.baselineFlipRate.flips}/${s.summary.baselineFlipRate.n} differ from repeat 1`)));
  target.replaceChildren(
    el('p', { class: 'note' }, 'Each adversarial alert (the source) is sent with 4 clear threat alerts (exposed), and the same 4 are sent without it '
      + '(control). Measured on the 4 companions only. A dangerous downgrade is a companion the policy auto-closes in the exposed batch but not in the control. '
      + 'Click a row for the batches, with the injected text highlighted.'),
    legend(series, colourOf),
    el('div', { class: 'table-wrap' }, el('table', { class: 'alerts-table' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Source'), el('th', {}, 'Injection aims at'), series.map(s => el('th', {}, s.name)))),
      el('tbody', {}, body, totals, baseline))));
}
