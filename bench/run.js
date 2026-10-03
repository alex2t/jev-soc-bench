/** CLI benchmark runner (plan.md section 7). See `npm run bench -- --dry-run` for the plan. */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { callJev } from '../src/providers/jev.js';
import { callLlm } from '../src/providers/llm.js';
import { mockJev, mockLlm } from '../src/providers/mock.js';
import { runBenchmark, selectAlerts, writeResults } from '../src/runner.js';
import { formatSummary } from '../src/report.js';
import { requireEnv, sha256 } from '../src/util.js';

const ENV = ['OPENROUTER_API_KEY', 'JEV_MODEL', 'LLM_MODEL'];
const KNOWN_PROVIDERS = ['jev', 'llm'];

const OPTIONS = {
  repeats: { type: 'string', default: '3' },
  providers: { type: 'string', default: 'jev,llm' },
  alerts: { type: 'string' },
  limit: { type: 'string' },
  concurrency: { type: 'string', default: '2' },
  'max-usd': { type: 'string', default: '0.50' },
  seed: { type: 'string' },
  label: { type: 'string' },
  out: { type: 'string', default: 'results' },
  'batch-size': { type: 'string', default: '1' },
  contamination: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  yes: { type: 'boolean', default: false },
  mock: { type: 'boolean', default: false },
};

function positiveInt(name, text) {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer, got ${JSON.stringify(text)}`);
  return n;
}

function parseOptions(argv) {
  const { values } = parseArgs({ args: argv, options: OPTIONS, strict: true });
  if (values['batch-size'] !== '1' || values.contamination) {
    throw new Error('--batch-size above 1 and --contamination are the M8 experiment (plan.md section 13), not built yet');
  }
  const providers = values.providers.split(',').map(p => p.trim());
  const unknown = providers.filter(p => !KNOWN_PROVIDERS.includes(p));
  if (unknown.length || new Set(providers).size !== providers.length) {
    throw new Error(`--providers must list distinct providers from ${KNOWN_PROVIDERS.join(', ')}, got ${values.providers}`);
  }
  const maxUsd = Number(values['max-usd']);
  if (!(maxUsd > 0)) throw new Error(`--max-usd must be a positive number, got ${JSON.stringify(values['max-usd'])}`);
  return {
    repeats: positiveInt('repeats', values.repeats),
    concurrency: positiveInt('concurrency', values.concurrency),
    limit: values.limit === undefined ? null : positiveInt('limit', values.limit),
    alertIds: values.alerts ? values.alerts.split(',').map(s => s.trim()) : null,
    seed: values.seed === undefined ? randomInt(0, 2 ** 31) : positiveInt('seed', values.seed),
    maxUsd,
    providers,
    label: values.label ?? null,
    out: values.out,
    dryRun: values['dry-run'],
    yes: values.yes,
    mock: values.mock,
  };
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function loadInputs() {
  const text = path => readFileSync(path, 'utf8');
  const questionsText = text('config/questions.json');
  const datasetText = text('data/alerts.json');
  return {
    questions: JSON.parse(questionsText),
    policy: JSON.parse(text('config/policy.json')),
    dataset: JSON.parse(datasetText),
    provenance: {
      nodeVersion: process.version,
      gitCommit: gitCommit(),
      questionsSha256: sha256(questionsText),
      datasetSha256: sha256(datasetText),
    },
  };
}

function planLines(opts, inputs, models, missing) {
  const alerts = selectAlerts(inputs.dataset.alerts, { ids: opts.alertIds, limit: opts.limit });
  const perProvider = alerts.length * opts.repeats;
  return [
    opts.mock ? 'Mode: MOCK (no model is called, no key needed)' : 'Mode: LIVE (paid calls through OpenRouter)',
    `Label: ${opts.label ?? 'none'}`,
    `Alerts: ${alerts.length} (${alerts[0].id} .. ${alerts.at(-1).id}), repeats ${opts.repeats}, concurrency ${opts.concurrency}, seed ${opts.seed}`,
    ...opts.providers.map(p => `  ${p}: ${perProvider} calls + 1 warm-up, model ${models[p] ?? 'MISSING'}`),
    `Total calls: ${opts.providers.length * (perProvider + 1)}`,
    `Budget guard: ${opts.mock ? 'off (mock)' : `on, --max-usd ${opts.maxUsd}; stops on any response without a cost`}`,
    `Dataset sha256 ${inputs.provenance.datasetSha256.slice(0, 12)}, labelled by ${inputs.dataset.labelledBy ?? 'NOT REVIEWED'}`,
    `Questions sha256 ${inputs.provenance.questionsSha256.slice(0, 12)}, git ${inputs.provenance.gitCommit ?? 'unknown'}`,
    ...(missing.length ? [`Missing environment variable(s) for a live run: ${missing.join(', ')}`] : []),
  ];
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim().toLowerCase() === 'y';
}

function providerCalls(opts, env) {
  if (opts.mock) return { models: { jev: 'MOCK', llm: 'MOCK' }, calls: { jev: mockJev, llm: mockLlm } };
  const models = { jev: env.JEV_MODEL, llm: env.LLM_MODEL };
  const apiKey = env.OPENROUTER_API_KEY;
  return {
    models,
    calls: {
      jev: args => callJev({ ...args, model: models.jev, apiKey }),
      llm: args => callLlm({ ...args, model: models.llm, apiKey }),
    },
  };
}

async function main() {
  const opts = parseOptions(process.argv.slice(2));
  const inputs = loadInputs();
  const missing = opts.mock ? [] : ENV.filter(n => !process.env[n]);
  const shownModels = opts.mock ? { jev: 'MOCK', llm: 'MOCK' } : { jev: process.env.JEV_MODEL, llm: process.env.LLM_MODEL };
  for (const line of planLines(opts, inputs, shownModels, missing)) console.log(line);
  if (opts.dryRun) return console.log('Dry run: nothing was called and no file was written.');

  const env = opts.mock ? {} : requireEnv(process.env, ENV);
  if (!opts.yes && !(await confirm(opts.mock ? 'Proceed with the mock run? [y/N] ' : 'Proceed with these PAID calls? [y/N] '))) {
    console.log('Aborted: nothing was called.');
    process.exitCode = 1;
    return;
  }
  const { models, calls } = providerCalls(opts, env);
  const result = await runBenchmark({
    ...inputs,
    providers: Object.fromEntries(opts.providers.map(p => [p, calls[p]])),
    models: Object.fromEntries(opts.providers.map(p => [p, models[p]])),
    options: { repeats: opts.repeats, concurrency: opts.concurrency, maxUsd: opts.maxUsd, seed: opts.seed,
      mock: opts.mock, label: opts.label, alertIds: opts.alertIds, limit: opts.limit },
  });
  const path = writeResults(opts.out, result);
  console.log('');
  for (const line of formatSummary(result)) console.log(line);
  console.log(`\nResults written to ${path}`);
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
});
