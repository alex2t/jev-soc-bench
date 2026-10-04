/**
 * npm run publish -- <runId> [--check] [--allow-partial]: verify a local results file, recompute
 * its summary and write it to the site (docs/data/). --check verifies and writes nothing.
 * The owner reviews `git diff` and commits; this script never commits or pushes.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { preparePublication, runIndex } from '../src/publish.js';
import { sha256 } from '../src/util.js';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/** The committed version of data/alerts.json whose file hash is `hash`, or null. */
function datasetAtHash(hash) {
  for (const commit of git('log', '--format=%H', '--', 'data/alerts.json').split('\n').filter(Boolean)) {
    const text = git('show', `${commit}:data/alerts.json`);
    if (sha256(text) === hash) return JSON.parse(text);
  }
  return null;
}

function currentCommit() {
  try {
    return git('rev-parse', '--short', 'HEAD').trim();
  } catch {
    return null;
  }
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      check: { type: 'boolean', default: false },
      'allow-partial': { type: 'boolean', default: false },
      results: { type: 'string', default: 'results' },
      site: { type: 'string', default: 'docs' },
    },
  });
  const [runId] = positionals;
  if (!runId) throw new Error('usage: npm run publish -- <runId> [--check] [--allow-partial]');
  const file = join(values.results, `${runId}.json`);
  if (!existsSync(file)) throw new Error(`no results file ${runId}.json in ${values.results}`);

  const run = JSON.parse(readFileSync(file, 'utf8'));
  const questionsText = readFileSync('config/questions.json', 'utf8');
  const dataset = JSON.parse(readFileSync('data/alerts.json', 'utf8'));
  const published = preparePublication(run, {
    dataset,
    questions: JSON.parse(questionsText),
    questionsSha256: sha256(questionsText),
    datasetAtHash,
    gitCommit: currentCommit(),
    now: new Date(),
    allowPartial: values['allow-partial'],
  });

  console.log(`${runId} "${run.meta.label ?? ''}"`);
  console.log('  questions: same as current');
  console.log(`  inputs: same as current${run.meta.datasetInputsSha256 ? '' : ' (dataset version found in git history)'}`);
  console.log(`  summary recomputed, no warnings; providers ${Object.keys(published.summary.providers).join(', ')}`);
  if (values.check) return console.log('Check only: nothing written.');

  const data = join(values.site, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, `${runId}.json`), `${JSON.stringify(published, null, 2)}\n`);
  writeFileSync(join(data, 'alerts.json'), `${JSON.stringify(dataset, null, 2)}\n`);
  const runs = readdirSync(data).filter(f => /^run-.*\.json$/.test(f)).map(f => JSON.parse(readFileSync(join(data, f), 'utf8')));
  writeFileSync(join(data, 'runs.json'), `${JSON.stringify(runIndex(runs), null, 2)}\n`);
  console.log(`Written to ${data}: ${runId}.json, alerts.json, runs.json (${runs.length} run(s)). Review with git diff, then commit.`);
}

try {
  main();
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
}
