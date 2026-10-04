/** Terminal summary table for a run. Unavailable values print as "unavailable" or "n/a", never 0. */

const pct = m => (m.value === null ? `n/a (n=${m.n})` : `${(m.value * 100).toFixed(1)}% (n=${m.n})`);
const ms = v => (v === null ? 'n/a' : `${Math.round(v)} ms`);
const usd = v => (v === null ? 'unavailable' : `$${v.toFixed(4)}`);
const num = m => (m.value === null ? `n/a (n=${m.n})` : `${m.value.toFixed(3)} (n=${m.n})`);

const ROWS = [
  ['Calls ok / errors', s => `${s.calls.ok} / ${s.calls.errors} (http ${s.calls.http_error}, timeout ${s.calls.timeout}, schema ${s.calls.schema_error})`],
  ['Queue accuracy, successful calls', s => `${pct(s.queue.accuracy.ok)}, errors ${s.queue.accuracy.ok.errors}`],
  ['Queue accuracy, end-to-end', s => `${pct(s.queue.accuracy.endToEnd)}, errors ${s.queue.accuracy.endToEnd.errors}`],
  ['Queue macro-F1', s => num(s.queue.macroF1)],
  ['Quarantine recall', s => pct(s.quarantine.recall)],
  ['Quarantine precision', s => pct(s.quarantine.precision)],
  ['Blast radius exact', s => pct(s.blastRadius.exactAccuracy)],
  ['Blast radius MAE', s => num(s.blastRadius.meanAbsError)],
  ['Latency p50 / p95', s => `${ms(s.latencyMs.p50)} / ${ms(s.latencyMs.p95)} (n=${s.latencyMs.n})`],
  ['Cost per 1,000 alerts', s => `${usd(s.cost.per1000AlertsUsd)} (known ${s.cost.knownCalls}, unknown ${s.cost.unknownCalls})`],
  ['Reasoning tokens per call', s => (s.reasoningTokens.n === 0
    ? `not reported (0 of ${s.reasoningTokens.unknownCalls} calls)`
    : `${Math.round(s.reasoningTokens.meanPerCall)} (n=${s.reasoningTokens.n})`)],
  ['Same queue across repeats', s => pct(s.consistency.sameQueueShare)],
  ['Auto quarantine / close / review', s => `${s.automation.auto_quarantine.count} / ${s.automation.auto_close.count} / ${s.automation.analyst_review.count}`],
  ['Threats auto-closed', s => `${s.automation.threatsAutoClosed.count}${s.automation.threatsAutoClosed.count ? ` (${s.automation.threatsAutoClosed.alertIds.join(', ')})` : ''}`],
  ['Injection followed', s => `${pct(s.injection)}${s.injection.alertIds.length ? ` (${s.injection.alertIds.join(', ')})` : ''}`],
];

/** Lines describing the run: banner, one block per provider, then warnings. */
export function formatSummary({ meta, summary }) {
  const lines = [];
  if (meta.mock) lines.push('Mock data. No model was called.');
  lines.push(`Run ${meta.runId}${meta.label ? ` "${meta.label}"` : ''}: ${meta.completedCalls} of ${meta.plannedCalls} calls, seed ${meta.seed}`);
  if (meta.stoppedByBudget) lines.push(`STOPPED: known cost reached the --max-usd limit ($${meta.maxUsd}).`);
  if (meta.stoppedByUnknownCost) lines.push('STOPPED: a response arrived without a cost, so the budget could not be enforced.');
  for (const [provider, s] of Object.entries(summary.providers)) {
    lines.push('', `${provider} (requested ${meta.requestedModels[provider]}, returned ${(meta.returnedModels[provider] ?? []).join(', ') || 'none'})`);
    for (const [label, format] of ROWS) {
      lines.push(`  ${label.padEnd(34)} ${format(s)}`);
      if (label !== 'Latency p50 / p95') continue;
      for (const [name, l] of Object.entries(s.latencyMs.byUpstream)) {
        lines.push(`    ${`upstream ${name}`.padEnd(32)} ${ms(l.p50)} / ${ms(l.p95)} (n=${l.n})`);
      }
    }
  }
  lines.push('', summary.warnings.length ? 'Warnings:' : 'Warnings: none');
  for (const w of summary.warnings) lines.push(`  WARNING ${w}`);
  return lines;
}
