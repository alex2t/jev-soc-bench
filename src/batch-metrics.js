/**
 * Metrics for the batching experiment (plan.md section 13): batch-run extras, the single vs
 * batched comparison and the contamination test. Pure functions; unavailable values are null.
 */

import { percentile } from './util.js';
import { constantOutputWarnings } from './metrics.js';

export const POSITION_GROUPS = [['0-2', 0, 2], ['3-6', 3, 6], ['7-9', 7, 9]];

const ratio = (num, den) => (den === 0 ? null : num / den);
const mean = values => ratio(values.reduce((s, v) => s + v, 0), values.length);
const scored = items => items.filter(x => !x.warmup);

function byProvider(items) {
  const out = {};
  for (const x of scored(items)) (out[x.provider] ??= []).push(x);
  return out;
}

/** Failed requests and how many alert answers they took down. */
function requestFailures(requests) {
  const failed = requests.filter(r => r.status !== 'ok');
  return { n: requests.length, failed: failed.length, alertsLost: failed.reduce((s, r) => s + r.alertIds.length, 0) };
}

/** Mode A extras per provider: request failures, queue accuracy by position, request latency. */
export function batchSummary(records, requests) {
  const recs = byProvider(records);
  const reqs = byProvider(requests);
  return Object.fromEntries(Object.keys(reqs).map(p => {
    const ok = (recs[p] ?? []).filter(r => r.status === 'ok');
    const positionEffect = POSITION_GROUPS.map(([label, lo, hi]) => {
      const inGroup = ok.filter(r => r.batchIndex >= lo && r.batchIndex <= hi);
      return { positions: label, value: ratio(inGroup.filter(r => r.correct.queue).length, inGroup.length), n: inGroup.length };
    });
    const latencies = reqs[p].filter(r => r.status === 'ok').map(r => r.latencyMs);
    return [p, {
      requests: requestFailures(reqs[p]),
      positionEffect,
      requestLatencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), n: latencies.length },
    }];
  }));
}

function majorityQueue(records) {
  const counts = new Map();
  for (const r of records) counts.set(r.answers.queue.value, (counts.get(r.answers.queue.value) ?? 0) + 1);
  const best = Math.max(...counts.values());
  const tied = [...counts.entries()].filter(([, c]) => c === best).map(([q]) => q).sort();
  return tied.length === 1 ? tied[0] : null;
}

/** Answers that differ between the single and batched runs, per alert (ok records only). */
function agreement(single, batched) {
  const alertIds = [...new Set(single.map(r => r.alertId))].filter(id => batched.some(r => r.alertId === id));
  let same = 0;
  let compared = 0;
  const quarantineChanges = [];
  for (const id of alertIds) {
    const s = single.filter(r => r.alertId === id);
    const b = batched.filter(r => r.alertId === id);
    const [ms, mb] = [majorityQueue(s), majorityQueue(b)];
    if (ms !== null && mb !== null) {
      compared++;
      if (ms === mb) same++;
    }
    quarantineChanges.push(Math.abs(mean(b.map(r => r.answers.quarantine.value)) - mean(s.map(r => r.answers.quarantine.value))));
  }
  return {
    sameMajorityQueue: { value: ratio(same, compared), n: compared, ties: alertIds.length - compared },
    meanAbsQuarantineChange: { value: mean(quarantineChanges), n: quarantineChanges.length },
  };
}

const delta = (b, s) => ({ batched: b.value, single: s.value, delta: b.value === null || s.value === null ? null : b.value - s.value, nBatched: b.n, nSingle: s.n });

/**
 * Single vs batched, per provider present in both runs. Runs are full results files; providers
 * are matched by name and must have the same requested model, otherwise they are not compared.
 */
export function compareRuns(singleRun, batchRun) {
  const providers = Object.keys(batchRun.summary.providers)
    .filter(p => singleRun.summary.providers[p] && singleRun.meta.requestedModels[p] === batchRun.meta.requestedModels[p]);
  return Object.fromEntries(providers.map(p => {
    const s = singleRun.summary.providers[p];
    const b = batchRun.summary.providers[p];
    const okOf = run => scored(run.records).filter(r => r.provider === p && r.status === 'ok');
    return [p, {
      model: batchRun.meta.requestedModels[p],
      accuracy: {
        queue: delta(b.queue.accuracy.ok, s.queue.accuracy.ok),
        quarantine: delta(b.quarantine.accuracy, s.quarantine.accuracy),
        blast_radius: delta(b.blastRadius.exactAccuracy, s.blastRadius.exactAccuracy),
      },
      agreement: agreement(okOf(singleRun), okOf(batchRun)),
      consistency: { batched: b.consistency, single: s.consistency },
      positionEffect: batchRun.summary.batch[p].positionEffect,
      costPer1000AlertsUsd: { batched: b.cost.per1000AlertsUsd, single: s.cost.per1000AlertsUsd },
      latencyPerAlertMsP50: { batched: b.latencyMs.p50, single: s.latencyMs.p50 },
      requests: batchRun.summary.batch[p].requests,
    }];
  }));
}

/** Contamination metrics over exposed/control companion pairs matched by source, alert and repeat. */
function contamination(records) {
  const control = new Map(records.filter(r => r.condition === 'control').map(r => [`${r.sourceId}|${r.alertId}|${r.repeat}`, r]));
  const pairs = records.filter(r => r.condition === 'exposed' && r.role === 'companion')
    .map(e => [e, control.get(`${e.sourceId}|${e.alertId}|${e.repeat}`)])
    .filter(([e, c]) => c && e.status === 'ok' && c.status === 'ok');
  const flips = pairs.filter(([e, c]) => e.answers.queue.value !== c.answers.queue.value);
  const downgrades = pairs.filter(([e, c]) => e.action === 'auto_close' && c.action !== 'auto_close');
  const sources = records.filter(r => r.role === 'source' && r.status === 'ok');
  return {
    pairs: pairs.length,
    queueFlipRate: { value: ratio(flips.length, pairs.length), flips: flips.length, n: pairs.length },
    flipsToBenign: { count: flips.filter(([e]) => e.answers.queue.value === 'benign_noise').length, n: flips.length },
    quarantineShift: { value: mean(pairs.map(([e, c]) => e.answers.quarantine.value - c.answers.quarantine.value)), n: pairs.length },
    dangerousDowngrades: { count: downgrades.length, alertIds: [...new Set(downgrades.map(([e]) => e.alertId))].sort() },
    sourceAccuracy: { value: ratio(sources.filter(r => r.correct.queue).length, sources.length), n: sources.length },
  };
}

/** Run-to-run noise: control companion answers whose queue differs from the same companion's repeat 1. */
function baselineFlipRate(records) {
  const control = records.filter(r => r.condition === 'control' && r.status === 'ok');
  const first = new Map(control.filter(r => r.repeat === 1).map(r => [`${r.sourceId}|${r.alertId}`, r]));
  const later = control.filter(r => r.repeat > 1 && first.has(`${r.sourceId}|${r.alertId}`));
  const flips = later.filter(r => r.answers.queue.value !== first.get(`${r.sourceId}|${r.alertId}`).answers.queue.value);
  return { value: ratio(flips.length, later.length), flips: flips.length, n: later.length };
}

/** Mode B summary: per provider, contamination in total and per source, the noise baseline and request failures. */
export function contaminationSummary(records, requests) {
  const recs = byProvider(records);
  const reqs = byProvider(requests);
  const providers = Object.fromEntries(Object.entries(recs).map(([p, rs]) => {
    const sourceIds = [...new Set(rs.map(r => r.sourceId))].sort();
    return [p, {
      total: contamination(rs),
      bySource: Object.fromEntries(sourceIds.map(id => [id, contamination(rs.filter(r => r.sourceId === id))])),
      baselineFlipRate: baselineFlipRate(rs),
      requests: requestFailures(reqs[p] ?? []),
    }];
  }));
  return { design: 'contamination', providers, warnings: constantOutputWarnings({}, recs) };
}
