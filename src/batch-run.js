/**
 * Batched runs (plan.md section 13): mode A, alerts in batches with rotated order per repeat, and
 * mode B, the contamination design. One request per batch; its answers are split into one record
 * per alert, with latency and usage divided evenly (apportioned). Raw responses are kept once per
 * request in `requests`, not copied onto every record.
 */

import { isCorrect, answerSchema } from './engine.js';
import { decide, checkPolicy } from './policy.js';
import { checkDataset } from './dataset.js';
import { summarize } from './metrics.js';
import { batchSummary, contaminationSummary } from './batch-metrics.js';
import { batchQuestions, splitAnswers, batchState, checkBatchSize, makeBatches, rotate, contaminationPairs } from './batch.js';
import { NORMALISE, makeBudget, runMeta, selectAlerts } from './runner.js';
import { seededRandom, shuffle, runPool } from './util.js';

/** Mode A: every batch x repeat x provider; the same batches for every provider. */
export function batchTasks(alerts, batchSize, providers, repeats, seed) {
  const batches = makeBatches(alerts, batchSize, seed);
  const tasks = batches.flatMap((batch, b) => Array.from({ length: repeats }, (_, i) => i + 1)
    .flatMap(repeat => providers.map(provider => ({
      batchId: `b-${String(b).padStart(2, '0')}-r${repeat}`, provider, repeat, alerts: rotate(batch, repeat), condition: null, sourceId: null,
    }))));
  return shuffle(tasks, seededRandom(`batch-tasks|${seed}`));
}

/** Mode B: every source x {exposed, control} x repeat x provider. */
export function contaminationTasks(alerts, providers, repeats, seed) {
  const tasks = contaminationPairs(alerts, seed).flatMap(pair => ['exposed', 'control'].flatMap(condition =>
    Array.from({ length: repeats }, (_, i) => i + 1).flatMap(repeat => providers.map(provider => ({
      batchId: `c-${pair.source.id}-${condition}-r${repeat}`, provider, repeat, alerts: pair[condition], condition, sourceId: pair.source.id,
    })))));
  return shuffle(tasks, seededRandom(`contamination-tasks|${seed}`));
}

function apportion(usage, n) {
  if (!usage) return null;
  return Object.fromEntries(Object.entries(usage).map(([k, v]) => [k, typeof v === 'number' ? v / n : v]));
}

/** One batch request -> the request entry and one record per alert in batch order. */
export async function runBatchRequest(task, ctx, warmup) {
  const n = task.alerts.length;
  const questions = batchQuestions(ctx.questions, n);
  const state = batchState(task.alerts);
  checkBatchSize(state, questions);
  const startedAt = ctx.clock().toISOString();
  const request = { batchId: task.batchId, provider: task.provider, repeat: task.repeat, warmup, startedAt,
    condition: task.condition, sourceId: task.sourceId, alertIds: task.alerts.map(a => a.id) };

  let res;
  let answers = null;
  let status = 'ok';
  let error = null;
  try {
    res = await ctx.providers[task.provider]({ state, questions, repeat: task.repeat });
    answers = splitAnswers(NORMALISE[task.provider](questions, res), n, ctx.questions);
  } catch (err) {
    if (!err.kind) throw err;
    status = err.kind;
    error = err.message;
  }
  const latencyMs = res?.latencyMs ?? null;
  Object.assign(request, { status, model: res?.model ?? null, upstreamProvider: res?.raw?.provider ?? null,
    latencyMs, usage: res?.usage ?? null, rawResponse: res?.raw ?? null, error });

  const records = task.alerts.map((alert, i) => {
    const decision = answers ? decide(answers[i], ctx.policy) : null;
    return {
      alertId: alert.id, provider: task.provider, repeat: task.repeat, warmup, startedAt,
      batchId: task.batchId, batchSize: n, batchIndex: i, condition: task.condition, sourceId: task.sourceId,
      role: task.sourceId ? (alert.id === task.sourceId ? 'source' : 'companion') : null,
      status, model: request.model, upstreamProvider: request.upstreamProvider,
      batchLatencyMs: latencyMs, latencyMs: latencyMs === null ? null : latencyMs / n,
      usage: apportion(request.usage, n), apportioned: true,
      answers: answers?.[i] ?? null, correct: answers ? isCorrect(answers[i], alert.expected) : null,
      action: decision?.action ?? null, actionReason: decision?.reason ?? null, rawResponse: null, error,
    };
  });
  return { request, records };
}

/**
 * Run mode A (`design: 'batch'`, options.batchSize) or mode B (`design: 'contamination'`).
 * Arguments as runBenchmark; the budget guard counts each request's full cost.
 */
export async function runBatchBenchmark({ design, questions, policy, dataset, providers, models, options, provenance, clock = () => new Date() }) {
  const datasetErrors = checkDataset(dataset, questions);
  if (datasetErrors.length) throw new Error(`dataset invalid: ${datasetErrors.join('; ')}`);
  checkPolicy(policy);
  answerSchema(questions);

  const { repeats, concurrency, maxUsd, seed, mock, batchSize = null, alertIds = null, limit = null } = options;
  const names = Object.keys(providers);
  const alerts = selectAlerts(dataset.alerts, { ids: alertIds, limit });
  const tasks = design === 'batch'
    ? batchTasks(alerts, batchSize, names, repeats, seed)
    : contaminationTasks(alerts, names, repeats, seed);
  const ctx = { providers, questions, policy, clock };
  const guard = makeBudget(mock, maxUsd);
  const startedAt = clock();

  const done = [];
  for (const provider of names) {
    const warm = await runBatchRequest({ ...tasks[0], provider, batchId: 'warmup', repeat: 0 }, ctx, true);
    guard.track(warm.request);
    done.push(warm);
  }
  const results = new Array(tasks.length);
  await runPool(tasks, concurrency, async (task, i) => {
    results[i] = await runBatchRequest(task, ctx, false);
    guard.track(results[i].request);
  }, guard.shouldStop);
  done.push(...results.filter(Boolean));

  const requests = done.map(d => d.request);
  const records = done.flatMap(d => d.records);
  const warmupRecords = records.filter(r => r.warmup).length;
  const meta = {
    ...runMeta({ startedAt, clock, options, policy, provenance, dataset, alerts, models, records, guard,
      batchSize: design === 'batch' ? batchSize : null, design, plannedCalls: tasks.reduce((s, t) => s + t.alerts.length, 0), warmups: warmupRecords }),
    plannedRequests: tasks.length,
    completedRequests: requests.filter(r => !r.warmup).length,
    apportioned: 'latencyMs and usage on each record are the batch totals divided evenly by the batch size',
  };
  const summary = design === 'batch'
    ? { ...summarize(records, dataset.alerts, questions), batch: batchSummary(records, requests) }
    : contaminationSummary(records, requests);
  return { meta, records, requests, summary };
}
