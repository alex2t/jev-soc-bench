/**
 * Cost estimate for a planned run (F-35), from measurements only: the mean cost per call in the
 * latest local live run with the same model (and, for the LLM, the same request settings).
 * Never a guessed number: without a measurement the estimate is null and the reason is given.
 */

function measuredCosts(run, provider) {
  return run.records.filter(r => r.provider === provider).map(r => r.usage?.costUsd).filter(c => typeof c === 'number');
}

/** Does `run` measure `provider` with this model and settings? Returns null, or a note when settings were not recorded. */
function matches(run, provider, { model, settings }) {
  if (run.meta.mock || run.meta.requestedModels?.[provider] !== model) return false;
  if (!settings) return { note: null };
  if (run.meta.requestSettings === undefined) return { note: 'settings not recorded in that run' };
  return JSON.stringify(run.meta.requestSettings?.[provider]) === JSON.stringify(settings) ? { note: null } : false;
}

function estimateProvider(runs, provider, plan) {
  const latestFirst = [...runs].sort((a, b) => String(b.meta.startedAt).localeCompare(String(a.meta.startedAt)));
  for (const run of latestFirst) {
    const match = matches(run, provider, plan);
    const costs = match ? measuredCosts(run, provider) : [];
    if (costs.length === 0) continue;
    const perCallUsd = costs.reduce((s, c) => s + c, 0) / costs.length;
    return { perCallUsd, totalUsd: perCallUsd * plan.calls, calls: plan.calls, measuredCalls: costs.length, source: run.meta.runId, note: match.note };
  }
  const settings = plan.settings ? ` ${JSON.stringify(plan.settings)}` : '';
  return { perCallUsd: null, totalUsd: null, calls: plan.calls, reason: `no measurement yet for ${plan.model}${settings}` };
}

/**
 * `plans` maps provider to { model, settings?, calls }. Returns per-provider estimates, the total
 * (null when any provider is unmeasured) and whether the total exceeds `maxUsd` (null if unknown).
 */
export function estimateCost(runs, plans, maxUsd) {
  const providers = Object.fromEntries(Object.entries(plans).map(([p, plan]) => [p, estimateProvider(runs, p, plan)]));
  const totals = Object.values(providers).map(e => e.totalUsd);
  const totalUsd = totals.some(t => t === null) ? null : totals.reduce((s, t) => s + t, 0);
  return { providers, totalUsd, exceedsMaxUsd: totalUsd === null ? null : totalUsd > maxUsd };
}
