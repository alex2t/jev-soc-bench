/** Validate data/alerts.json against config/questions.json and print its composition. */

import { readFileSync } from 'node:fs';
import { checkDataset, datasetStats } from '../src/dataset.js';

const questions = JSON.parse(readFileSync('config/questions.json', 'utf8'));
const dataset = JSON.parse(readFileSync('data/alerts.json', 'utf8'));
const errors = checkDataset(dataset, questions);

for (const e of errors) console.log(`ERROR ${e}`);
if (errors.length) {
  console.log(`${errors.length} error(s).`);
  process.exitCode = 1;
} else {
  const s = datasetStats(dataset);
  console.log(`Dataset valid: ${s.total} alerts.`);
  console.log(`  by queue:        ${JSON.stringify(s.byQueue)}`);
  console.log(`  by difficulty:   ${JSON.stringify(s.byDifficulty)}`);
  console.log(`  by blast_radius: ${JSON.stringify(s.byBlastRadius)}`);
  console.log(`  quarantine true: ${s.quarantineTrue} of ${s.total}`);
  console.log(`  cross-alert injection: ${s.crossAlertInjection.join(', ')}`);
  console.log(`  labelledBy: ${s.labelledBy ?? 'null (labels NOT yet reviewed by the owner)'}`);
}
