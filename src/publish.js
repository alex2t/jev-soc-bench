/**
 * Verify a results file and prepare it for the public site (plan.md section 9, F-30, F-31).
 * A run is publishable when the models saw the same questions and alert states as the current
 * repository; its summary is then recomputed with the current metrics and labels.
 */

import { summarize } from './metrics.js';
import { inputsSha256, labelsSha256 } from './dataset.js';

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

  const summary = summarize(run.records, ctx.dataset.alerts, ctx.questions);
  if (summary.warnings.length) throw new Error(`warnings after recomputing the summary: ${summary.warnings.join('; ')}`);

  const published = {
    ...run,
    meta: {
      ...meta,
      datasetInputsSha256: inputs,
      scoredWithLabelsSha256: labelsSha256(ctx.dataset),
      summaryComputedAt: ctx.now.toISOString(),
      summaryGitCommit: ctx.gitCommit,
      publishedPartial: Boolean(stopped),
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
