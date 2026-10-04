/**
 * Renders the published runs in docs/data/. Data is inserted with textContent and DOM APIs only,
 * never as HTML: alert states contain attacker-style text (plan.md section 9).
 */

import { buildViews, viewLabel, threatsAutoClosed } from './model.js';
import { drawDifficulty, drawLatency, drawCalibration, drawAutomation } from './charts.js';
import { drawAlerts } from './alerts.js';
import { el, pct, ms, usd, swatch } from './dom.js';

const short = h => String(h ?? 'none').slice(0, 12);

async function loadJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

function row(label, value, extra) {
  return [el('dt', {}, label), el('dd', {}, value, extra ? el('small', {}, ` ${extra}`) : null)];
}

function card(s, i) {
  const m = s.summary;
  const acc = m.queue.accuracy;
  const inj = m.injection;
  const threats = m.automation.threatsAutoClosed.count;
  const upstreams = Object.entries(m.latencyMs.byUpstream)
    .map(([name, u]) => row(`  via ${name}`, `${ms(u.p50)} / ${ms(u.p95)}`, `n=${u.n}`));
  return el('article', { class: 'card', style: { '--swatch': swatch(i) } },
    el('h3', {}, s.name),
    el('p', { class: 'sub' }, `${s.run.meta.returnedModels[s.provider].join(', ')} - ${s.run.meta.runId}`),
    el('dl', {},
      row('Queue accuracy (successful calls)', pct(acc.ok.value), `${acc.ok.correct}/${acc.ok.n}`),
      row('Queue accuracy (end-to-end)', pct(acc.endToEnd.value), `${acc.endToEnd.errors} errors`),
      row('Prompt injection followed', inj.n ? `${inj.followed}/${inj.n}` : 'no injection alert', inj.alertIds.join(', ')),
      [el('dt', {}, 'Threats auto-closed'), el('dd', { class: threats > 0 ? 'bad' : '' }, String(threats))],
      row('Quarantine recall', pct(m.quarantine.recall.value), `n=${m.quarantine.recall.n}`),
      row('Latency p50 / p95', `${ms(m.latencyMs.p50)} / ${ms(m.latencyMs.p95)}`, `n=${m.latencyMs.n}`),
      upstreams.length > 1 ? upstreams : null,
      row('Cost per 1,000 alerts', usd(m.cost.per1000AlertsUsd), m.cost.unknownCalls ? `${m.cost.unknownCalls} calls without cost` : null),
      row('Schema failures', pct(m.calls.schemaFailureRate), `${m.calls.schema_error}/${m.calls.n} calls`),
    ));
}

function drawCards(view) {
  document.getElementById('cards-body').replaceChildren(...view.series.map(card));
}

function drawThreats(view, alerts) {
  const items = view.series.flatMap(s => threatsAutoClosed(s, alerts).map(t => el('li', {},
    el('strong', {}, `${s.name}: ${t.id}`), ` auto-closed in ${t.count} of its calls; labelled ${t.expectedQueue}. `,
    `Label rationale: "${t.rationale}"`)));
  document.getElementById('threats').replaceChildren(
    el('h3', {}, 'Threats auto-closed'),
    items.length ? el('ul', { class: 'threats' }, items) : el('p', { class: 'note' }, 'None: no model auto-closed an alert labelled as a threat.'),
    items.length ? el('p', { class: 'note' }, 'An auto-closed threat is a call the policy closed automatically although the alert is labelled as a threat. '
      + 'Labels were reviewed before the first benchmark run and have not been changed since, including where a model disagreed.') : null);
}

function methodRun(run) {
  const m = run.meta;
  const list = obj => Object.entries(obj ?? {}).map(([p, v]) => `${p}: ${[].concat(v).join(', ')}`).join('; ') || 'none recorded';
  const settings = m.requestSettings ? list(Object.fromEntries(Object.entries(m.requestSettings).map(([p, v]) => [p, JSON.stringify(v)]))) : 'none (model defaults)';
  return el('div', {},
    el('h3', {}, `${m.runId} "${m.label ?? ''}"`),
    el('dl', {},
      row('Started', m.startedAt),
      row('Models requested', list(m.requestedModels)),
      row('Models returned', list(m.returnedModels)),
      row('Upstream providers', list(m.returnedProviders)),
      row('LLM request settings', settings),
      row('blast_radius level', list(m.levelDerivation)),
      row('Repeats, seed', `${m.repeats} repeats, seed ${m.seed}, concurrency ${m.concurrency}`),
      row('Scored calls', `${m.completedCalls} of ${m.plannedCalls} planned`),
      row('Budget guard', `${m.budgetGuard}, limit $${m.maxUsd}, spent $${m.spentUsd.toFixed(4)}${m.stoppedByBudget || m.stoppedByUnknownCost ? ' (stopped early)' : ''}`),
      row('Hashes', `questions ${short(m.questionsSha256)}, inputs ${short(m.datasetInputsSha256)}, labels ${short(m.scoredWithLabelsSha256)}`),
      row('Run code', `git ${m.gitCommit}, Node ${m.nodeVersion}`),
      row('Summary computed', `${m.summaryComputedAt} by git ${m.summaryGitCommit} (recomputed when published)`),
    ));
}

function drawMethod(view) {
  document.getElementById('method').replaceChildren(
    el('p', { class: 'note' }, 'These runs are shown together because they share the same questions, the same alert inputs and the same labels.'),
    ...view.runs.map(methodRun),
    el('h3', {}, 'Caveats'),
    el('ul', {},
      el('li', {}, 'The LLMs return no confidence, so the policy rule "send low-confidence answers to an analyst" never fires for them, and their quarantine probabilities are self-reported estimates.'),
      el('li', {}, 'blast_radius: Jev returns a probability per level (level = the most likely one); the LLMs return a number, rounded half-up to a level.'),
      el('li', {}, 'LLM latency depends on which upstream provider OpenRouter routed each call to; it is shown per upstream as well.'),
      el('li', {}, 'Cost is the usage.cost OpenRouter reported for each call; a call without it is counted as unavailable, never as zero.'),
      el('li', {}, 'The alerts are synthetic (documentation IP ranges, example.com domains, invented users) and labelled by one reviewer, Alex2t.'),
    ));
}

function render(view, alerts) {
  document.getElementById('mock-banner').hidden = !view.runs.some(r => r.meta.mock);
  drawCards(view);
  drawDifficulty(view);
  drawLatency(view);
  drawCalibration(view);
  drawAutomation(view);
  drawThreats(view, alerts);
  drawConfusion(view);
  drawAlerts(view, alerts);
  drawMethod(view);
}

function drawConfusion(view) {
  const blocks = view.series.map(s => {
    const { matrix } = s.summary.queue.confusion;
    const queues = Object.keys(matrix);
    return el('div', {},
      el('h3', {}, s.name),
      el('div', { class: 'table-wrap' }, el('table', { class: 'matrix' },
        el('thead', {}, el('tr', {}, el('th', {}, 'label vs chosen'), queues.map(q => el('th', {}, q)))),
        el('tbody', {}, queues.map(expected => el('tr', {},
          el('th', {}, expected),
          queues.map(chosen => el('td', { class: expected === chosen ? 'hit' : (matrix[expected][chosen] ? 'wrong' : '') },
            String(matrix[expected][chosen])))))))));
  });
  document.getElementById('confusion').replaceChildren(...blocks);
}

async function main() {
  const status = document.getElementById('status');
  try {
    const index = await loadJson('data/runs.json');
    const [alerts, ...runs] = await Promise.all([loadJson('data/alerts.json'), ...index.map(r => loadJson(`data/${r.runId}.json`))]);
    const views = buildViews(runs);
    if (!views.length) throw new Error('no published run');
    const picker = document.getElementById('view');
    picker.replaceChildren(...views.map((v, i) => el('option', { value: String(i) }, viewLabel(v))));
    picker.addEventListener('change', () => render(views[Number(picker.value)], alerts.alerts));
    render(views[0], alerts.alerts);
    status.hidden = true;
    document.getElementById('main').hidden = false;
  } catch (err) {
    status.textContent = `Could not load the published runs: ${err.message}`;
    throw err;
  }
}

if (typeof document !== 'undefined') main();
