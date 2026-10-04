/**
 * Pure data shaping for the dashboard: no DOM, so it is tested under Node (site.test.js).
 * A "view" combines published runs that asked the same questions about the same alert states and
 * were scored against the same labels (F-36); each provider in those runs becomes one series.
 */

/** Runs whose questions, inputs and labels fingerprints match can be shown side by side. */
export function compatibilityKey(meta) {
  return [meta.questionsSha256, meta.datasetInputsSha256, meta.scoredWithLabelsSha256].join(':');
}

/** "openai/gpt-4o-mini" -> "gpt-4o-mini". */
export function modelName(model) {
  return String(model).split('/').pop();
}

/**
 * One series per model across the given runs, Jev first, then LLMs in run order (oldest first).
 * When two runs measured the same model, the newest run wins.
 */
export function seriesOf(runs) {
  const byModel = new Map();
  const oldestFirst = [...runs].sort((a, b) => a.meta.startedAt.localeCompare(b.meta.startedAt));
  for (const run of oldestFirst) {
    for (const provider of Object.keys(run.summary.providers)) {
      const model = run.meta.requestedModels[provider];
      byModel.delete(model);
      byModel.set(model, {
        id: `${run.meta.runId}:${provider}`,
        name: modelName(model),
        model,
        provider,
        run,
        summary: run.summary.providers[provider],
        records: run.records.filter(r => r.provider === provider && !r.warmup),
      });
    }
  }
  const series = [...byModel.values()];
  return [...series.filter(s => s.provider === 'jev'), ...series.filter(s => s.provider !== 'jev')];
}

/** Group runs into views, newest view first; each view lists its runs and its series. */
export function buildViews(runs) {
  const groups = new Map();
  for (const run of runs) {
    const key = compatibilityKey(run.meta);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  const newest = rs => rs.map(r => r.meta.startedAt).sort().at(-1);
  return [...groups.entries()]
    .map(([key, rs]) => ({ key, runs: rs, series: seriesOf(rs) }))
    .sort((a, b) => newest(b.runs).localeCompare(newest(a.runs)));
}

/** A view's label for the selector: its models and how many runs it combines. */
export function viewLabel(view) {
  const runs = view.runs.length === 1 ? '1 run' : `${view.runs.length} runs`;
  return `${view.series.map(s => s.name).join(' vs ')} (${runs})`;
}

/**
 * Per-alert rows for the table: the alert, and for each series the answers of every repeat, the
 * number of correct queue answers, mean latency and summed cost (null when any cost is unknown).
 * `disagreement`: some series gave a queue other than the label, or an error, on some repeat.
 */
export function alertRows(alerts, series) {
  return alerts.map(alert => {
    const cells = series.map(s => {
      const records = s.records.filter(r => r.alertId === alert.id);
      const ok = records.filter(r => r.status === 'ok');
      const costs = records.map(r => r.usage?.costUsd);
      return {
        seriesId: s.id,
        records,
        queues: records.map(r => (r.status === 'ok' ? r.answers.queue.value : r.status)),
        queueCorrect: ok.filter(r => r.correct.queue).length,
        n: records.length,
        meanLatencyMs: ok.length ? ok.reduce((t, r) => t + r.latencyMs, 0) / ok.length : null,
        costUsd: costs.some(c => typeof c !== 'number') ? null : costs.reduce((t, c) => t + c, 0),
      };
    });
    const allRight = cells.every(c => c.n > 0 && c.queueCorrect === c.n);
    return { alert, cells, disagreement: !allRight };
  });
}

/**
 * The alerts the summary lists as threats auto-closed (F-38), each with how many of its calls were
 * auto-closed and the label rationale recorded in the dataset.
 */
export function threatsAutoClosed(seriesItem, alerts) {
  const byId = new Map(alerts.map(a => [a.id, a]));
  return seriesItem.summary.automation.threatsAutoClosed.alertIds.map(id => ({
    id,
    count: seriesItem.records.filter(r => r.alertId === id && r.status === 'ok' && r.action === 'auto_close').length,
    expectedQueue: byId.get(id).expected.queue,
    rationale: byId.get(id).rationale,
  }));
}
