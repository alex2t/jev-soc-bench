/** Per-alert table with filters, and the detail dialog showing state, labels and raw responses. */

import { alertRows } from './model.js';
import { el, ms } from './dom.js';

/** "benign_noise x3" or "cloud_iam x2, benign_noise x1". */
function summarise(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].map(([v, n]) => `${v} x${n}`).join(', ');
}

function meanConfidence(records) {
  const c = records.filter(r => r.status === 'ok' && r.answers.queue.confidence != null).map(r => r.answers.queue.confidence);
  return c.length ? c.reduce((t, v) => t + v, 0) / c.length : null;
}

function cell(c) {
  const conf = meanConfidence(c.records);
  const cost = c.costUsd == null ? 'cost unavailable' : `$${c.costUsd.toFixed(5)}`;
  return el('td', {},
    el('div', { class: c.queueCorrect === c.n ? 'ok' : 'wrong' }, `${c.queueCorrect}/${c.n} `, summarise(c.queues)),
    el('small', {}, [conf == null ? null : `confidence ${(conf * 100).toFixed(0)}%, `, `${ms(c.meanLatencyMs)}, ${cost}`].join('')));
}

function detail(row, view) {
  const { alert } = row;
  const sections = view.series.map((s, i) => el('div', {},
    el('h3', {}, s.name),
    [...row.cells[i].records].sort((a, b) => a.repeat - b.repeat).map(r => el('details', {},
      el('summary', {}, `Repeat ${r.repeat}: ${r.status}${r.status === 'ok' ? `, ${r.answers.queue.value}, action ${r.action}` : ''}`),
      el('pre', {}, JSON.stringify(r.rawResponse ?? r.error ?? null, null, 2))))));
  document.getElementById('detail-body').replaceChildren(
    el('h2', {}, `${alert.id} (${alert.difficulty})`),
    el('h3', {}, 'Alert state (what every model saw)'),
    el('pre', {}, JSON.stringify(alert.state, null, 2)),
    el('h3', {}, 'Labels'),
    el('pre', {}, JSON.stringify({ expected: alert.expected, injectionTarget: alert.injectionTarget }, null, 2)),
    el('p', {}, `Rationale: ${alert.rationale}`),
    el('h3', {}, 'Raw responses'),
    ...sections);
  document.getElementById('detail').showModal();
}

export function drawAlerts(view, alerts) {
  const rows = alertRows(alerts, view.series);
  const difficulty = document.getElementById('filter-difficulty');
  const disagree = document.getElementById('filter-disagree');
  const target = document.getElementById('alerts');

  const draw = () => {
    const shown = rows.filter(r => (!difficulty.value || r.alert.difficulty === difficulty.value) && (!disagree.checked || r.disagreement));
    const body = shown.map(r => {
      const tr = el('tr', { tabindex: 0 },
        el('td', {}, r.alert.id), el('td', {}, r.alert.difficulty), el('td', {}, r.alert.expected.queue),
        r.cells.map(cell));
      tr.addEventListener('click', () => detail(r, view));
      tr.addEventListener('keydown', e => { if (e.key === 'Enter') detail(r, view); });
      return tr;
    });
    target.replaceChildren(
      el('p', { class: 'note' }, `${shown.length} of ${rows.length} alerts. Each cell: correct queue answers out of repeats, the answers given, then mean latency and summed cost. Click a row for the alert, its labels and the raw responses.`),
      el('table', { class: 'alerts-table' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Alert'), el('th', {}, 'Difficulty'), el('th', {}, 'Labelled queue'), view.series.map(s => el('th', {}, s.name)))),
        el('tbody', {}, body)));
  };
  difficulty.onchange = draw;
  disagree.onchange = draw;
  draw();
}
