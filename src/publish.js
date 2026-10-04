/**
 * Verify a results file and prepare it for the public site (plan.md section 9, F-30, F-31).
 * A run is publishable when the models saw the same questions and alert states as the current
 * repository; its summary is then recomputed with the current metrics and labels.
 */

import { summarize } from './metrics.js';
import { batchSummary, contaminationSummary } from './batch-metrics.js';
import { inputsSha256, labelsSha256 } from './dataset.js';
import { normaliseUsage } from './providers/jev.js';

const KEY_PATTERN = /sk-or-v1-[0-9a-f]{32,}/i;
const short = h => String(h).slice(0, 12);

/**
 * The inputs fingerprint of the dataset a run used: recorded in meta for newer runs; for older
 * ones, computed from the dataset version whose file hash the run recorded (`datasetAtHash`).
 */
function runInputs(meta, datasetAtHash) {
  if (meta.datasetInputsSha256) return meta.datasetInputsSha256;
  const used = datasetAtHash(meta.datasetSha256);
  if (!used) throw new Error(`cannot find the dataset version this run used (file sha256 ${short(meta.datasetSha256)})`);
  return inputsSha256(used);
}

/** The summary for the run's design, from its records (and requests, for batched designs). */
function recompute(run, ctx) {
  if (run.meta.design === 'contamination') return contaminationSummary(run.records, run.requests);
  const summary = summarize(run.records, ctx.dataset.alerts, ctx.questions);
  return run.meta.design === 'batch' ? { ...summary, batch: batchSummary(run.records, run.requests) } : summary;
}

/**
 * Records made before F-43 have no `usage.cachedInputTokens`; take it from the raw response kept in
 * the record (single alert) or in its request (batched, divided by the batch size). Returns the
 * records and how many were filled.
 */
function backfillCachedTokens(run) {
  const requests = new Map((run.requests ?? []).map(q => [`${q.provider}|${q.batchId}`, q]));
  let filled = 0;
  const records = run.records.map(r => {
    if (!r.usage || 'cachedInputTokens' in r.usage) return r;
    const request = requests.get(`${r.provider}|${r.batchId}`);
    const cached = normaliseUsage((r.rawResponse ?? request?.rawResponse)?.usage)?.cachedInputTokens ?? null;
    filled++;
    return { ...r, usage: { ...r.usage, cachedInputTokens: cached === null || !request ? cached : cached / r.batchSize } };
  });
  return { records, filled };
}

/**
 * Return the run as it will be published, or throw naming the first check that failed.
 * `ctx`: { dataset, questions, questionsSha256, datasetAtHash, gitCommit, now, allowPartial }.
 */
export function preparePublication(run, ctx) {
  const { meta } = run;
  if (meta.mock) throw new Error('mock runs are never published');
  const stopped = meta.stoppedByBudget || meta.stoppedByUnknownCost;
  if (stopped && !ctx.allowPartial) throw new Error('this run stopped early (budget guard); use --allow-partial to publish it anyway');
  if (meta.questionsSha256 !== ctx.questionsSha256) {
    throw new Error(`questions changed since this run (run ${short(meta.questionsSha256)}, current ${short(ctx.questionsSha256)})`);
  }
  const inputs = runInputs(meta, ctx.datasetAtHash);
  if (inputs !== inputsSha256(ctx.dataset)) throw new Error('alert states sent in this run differ from the current dataset');

  const { records, filled } = backfillCachedTokens(run);
  const summary = recompute({ ...run, records }, ctx);
  if (summary.warnings.length) throw new Error(`warnings after recomputing the summary: ${summary.warnings.join('; ')}`);

  const published = {
    ...run,
    records,
    meta: {
      ...meta,
      datasetInputsSha256: inputs,
      scoredWithLabelsSha256: labelsSha256(ctx.dataset),
      summaryComputedAt: ctx.now.toISOString(),
      summaryGitCommit: ctx.gitCommit,
      publishedPartial: Boolean(stopped),
      ...(filled ? { usageBackfill: `cachedInputTokens for ${filled} records taken from rawResponse at publication (F-43)` } : {}),
    },
    summary,
    runSummary: run.runSummary ?? run.summary,
  };
  if (KEY_PATTERN.test(JSON.stringify(published))) throw new Error('the run contains a key-shaped string; not published');
  return published;
}

/** One line per published run for docs/data/runs.json, newest first. */
export function runIndex(runs) {
  return runs
    .map(({ meta, summary }) => ({
      runId: meta.runId,
      label: meta.label,
      startedAt: meta.startedAt,
      providers: Object.keys(summary.providers).sort(),
      requestedModels: meta.requestedModels,
      returnedModels: meta.returnedModels,
      upstreams: meta.returnedProviders,
      requestSettings: meta.requestSettings ?? null,
      scoredCalls: meta.completedCalls,
      questionsSha256: meta.questionsSha256,
      datasetInputsSha256: meta.datasetInputsSha256,
      scoredWithLabelsSha256: meta.scoredWithLabelsSha256,
      summaryComputedAt: meta.summaryComputedAt,
    }))
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}
