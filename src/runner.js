/** Benchmark core (plan.md section 7): tasks, calls, records, budget guard, meta and results file. */

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normaliseJev, normaliseLlm, isCorrect, answerSchema } from './engine.js';
import { decide, checkPolicy } from './policy.js';
import { checkDataset } from './dataset.js';
import { summarize } from './metrics.js';
import { seededRandom, shuffle, runPool } from './util.js';

const NORMALISE = {
  jev: (questions, res) => normaliseJev(questions, res.raw),
  llm: (questions, res) => normaliseLlm(questions, res.text),
};

export const LEVEL_DERIVATION = { jev: 'argmax of probabilities', llm: 'Math.round, half-up' };

/** Alerts chosen by --alerts (IDs, dataset order kept) and --limit; unknown IDs are an error. */
export function selectAlerts(alerts, { ids = null, limit = null } = {}) {
  let selected = alerts;
  if (ids) {
    const unknown = ids.filter(id => !alerts.some(a => a.id === id));
    if (unknown.length) throw new Error(`unknown alert ID(s): ${unknown.join(', ')}`);
    selected = alerts.filter(a => ids.includes(a.id));
  }
  if (limit !== null) selected = selected.slice(0, limit);
  if (selected.length === 0) throw new Error('no alerts selected');
  return selected;
}

/** Every (alert x repeat x provider), shuffled with the seed so no provider always goes first. */
export function buildTasks(alerts, providers, repeats, seed) {
  const tasks = alerts.flatMap(a => Array.from({ length: repeats }, (_, i) => i + 1)
    .flatMap(repeat => providers.map(provider => ({ alertId: a.id, provider, repeat }))));
  return shuffle(tasks, seededRandom(`tasks|${seed}`));
}

function baseRecord(task, startedAt, warmup) {
  return { alertId: task.alertId, provider: task.provider, repeat: task.repeat, warmup, startedAt };
}

/** One call -> one record. Errors with a `kind` become records; any other error is a bug and propagates. */
async function runTask(task, ctx, warmup) {
  const alert = ctx.alertsById[task.alertId];
  const base = baseRecord(task, ctx.clock().toISOString(), warmup);
  let res;
  try {
    res = await ctx.providers[task.provider]({ state: alert.state, questions: ctx.questions, repeat: task.repeat });
  } catch (err) {
    if (!err.kind) throw err;
    return { ...base, status: err.kind, model: null, upstreamProvider: null, latencyMs: err.latencyMs ?? null,
      usage: null, answers: null, correct: null, action: null, actionReason: null, rawResponse: null, error: err.message };
  }
  const responded = { model: res.model, upstreamProvider: res.raw?.provider ?? null, latencyMs: res.latencyMs, usage: res.usage, rawResponse: res.raw };
  try {
    const answers = NORMALISE[task.provider](ctx.questions, res);
    const { action, reason } = decide(answers, ctx.policy);
    return { ...base, status: 'ok', ...responded, answers, correct: isCorrect(answers, alert.expected),
      action, actionReason: reason, error: null };
  } catch (err) {
    if (err.kind !== 'schema_error') throw err;
    return { ...base, status: 'schema_error', ...responded, answers: null, correct: null, action: null,
      actionReason: null, error: err.message };
  }
}

/**
 * Budget guard (F-4): in a live run, stop scheduling once known cost reaches maxUsd, or as soon
 * as a response arrives without a numeric cost, because the budget can then not be enforced.
 */
function makeBudget(mock, maxUsd) {
  const budget = { spentUsd: 0, stoppedByBudget: false, stoppedByUnknownCost: false };
  return {
    budget,
    track(record) {
      if (mock || record.rawResponse == null) return;
      const cost = record.usage?.costUsd;
      if (typeof cost !== 'number') budget.stoppedByUnknownCost = true;
      else budget.spentUsd += cost;
      if (budget.spentUsd >= maxUsd) budget.stoppedByBudget = true;
    },
    shouldStop: () => !mock && (budget.stoppedByBudget || budget.stoppedByUnknownCost),
  };
}

function distinct(records, field) {
  const out = {};
  for (const r of records) if (r[field] != null) (out[r.provider] ??= new Set()).add(r[field]);
  return Object.fromEntries(Object.entries(out).map(([p, s]) => [p, [...s].sort()]));
}

export function runId(date) {
  const p = n => String(n).padStart(2, '0');
  return `run-${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}`
    + `-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`;
}

/**
 * Run the standard single-alert benchmark. `providers` maps provider name to
 * `({ state, questions, repeat }) => { raw, text?, latencyMs, model, usage }`.
 */
export async function runBenchmark({ questions, policy, dataset, providers, models, options, provenance, clock = () => new Date() }) {
  const datasetErrors = checkDataset(dataset, questions);
  if (datasetErrors.length) throw new Error(`dataset invalid: ${datasetErrors.join('; ')}`);
  checkPolicy(policy);
  answerSchema(questions);

  const { repeats, concurrency, maxUsd, seed, mock, label = null, alertIds = null, limit = null, requestSettings = null } = options;
  const names = Object.keys(providers);
  const alerts = selectAlerts(dataset.alerts, { ids: alertIds, limit });
  const tasks = buildTasks(alerts, names, repeats, seed);
  const ctx = { providers, questions, policy, clock, alertsById: Object.fromEntries(dataset.alerts.map(a => [a.id, a])) };
  const guard = makeBudget(mock, maxUsd);
  const startedAt = clock();

  const warmups = [];
  for (const provider of names) {
    const record = await runTask({ alertId: alerts[0].id, provider, repeat: 0 }, ctx, true);
    guard.track(record);
    warmups.push(record);
  }
  const results = new Array(tasks.length);
  await runPool(tasks, concurrency, async (task, i) => {
    results[i] = await runTask(task, ctx, false);
    guard.track(results[i]);
  }, guard.shouldStop);
  const records = [...warmups, ...results.filter(Boolean)];

  const meta = {
    runId: runId(startedAt),
    label,
    startedAt: startedAt.toISOString(),
    finishedAt: clock().toISOString(),
    mock,
    seed,
    repeats,
    concurrency,
    batchSize: 1,
    design: 'standard',
    ...provenance,
    labelledBy: dataset.labelledBy,
    alerts: alerts.length,
    policy,
    requestedModels: models,
    returnedModels: distinct(records, 'model'),
    returnedProviders: distinct(records, 'upstreamProvider'),
    requestSettings,
    levelDerivation: LEVEL_DERIVATION,
    budgetGuard: mock ? 'off (mock)' : 'on',
    maxUsd: mock ? null : maxUsd,
    spentUsd: mock ? null : guard.budget.spentUsd,
    stoppedByBudget: guard.budget.stoppedByBudget,
    stoppedByUnknownCost: guard.budget.stoppedByUnknownCost,
    plannedCalls: tasks.length,
    completedCalls: records.length - warmups.length,
  };
  return { meta, records, summary: summarize(records, dataset.alerts, questions) };
}

/** Write results/<runId>.json atomically (temp file, then rename); never overwrite a run. */
export function writeResults(dir, result) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${result.meta.runId}.json`);
  if (existsSync(path)) throw new Error(`${path} already exists`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`);
  renameSync(tmp, path);
  return path;
}
