/**
 * One live call per provider on alert SEC-0001: prints the raw responses (key redacted) and
 * answers the plan.md section 5 checklist. `--mock` runs the same script on the mock providers.
 */

import { readFileSync } from 'node:fs';
import { callJev } from '../src/providers/jev.js';
import { callLlm } from '../src/providers/llm.js';
import { mockJev, mockLlm } from '../src/providers/mock.js';
import { normaliseJev, normaliseLlm } from '../src/engine.js';
import { requestSettings } from '../src/models.js';
import { requireEnv } from '../src/util.js';

// SEC-0001 from plan.md section 4; the dataset itself arrives in M3.
const STATE = {
  alert_id: 'SEC-0001',
  timestamp: '2026-10-03T18:30:00Z',
  source: 'AWS CloudTrail',
  source_ip: '198.51.100.44',
  event_type: 'IAM anomaly',
  details: "IAM user 'ci-runner' called iam:CreateAccessKey and iam:AttachUserPolicy with AdministratorAccess from an ASN never seen for this account. 43 failed API calls preceded the first success.",
};

function settings(mock) {
  if (mock) return { apiKey: null, jevModel: 'MOCK', llmModel: 'MOCK', jev: mockJev, llm: mockLlm };
  const env = requireEnv(process.env, ['OPENROUTER_API_KEY', 'JEV_MODEL', 'LLM_MODEL']);
  const llmSettings = requestSettings(JSON.parse(readFileSync('config/models.json', 'utf8')), env.LLM_MODEL);
  return { apiKey: env.OPENROUTER_API_KEY, jevModel: env.JEV_MODEL, llmModel: env.LLM_MODEL, llmSettings, jev: callJev, llm: callLlm };
}

function redact(text, apiKey) {
  return apiKey ? text.replaceAll(apiKey, '[REDACTED]') : text;
}

async function attempt(call) {
  try {
    return { result: await call() };
  } catch (err) {
    return { error: `${err.name}: ${err.message}${err.status ? ` (status ${err.status})` : ''}` };
  }
}

function normalise(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return { ok: false, error: `${err.kind ?? err.name}: ${err.message}` };
  }
}

function printCall(name, requested, outcome, apiKey) {
  console.log(`\n=== ${name} (requested ${requested}) ===`);
  if (outcome.error) return console.log(`call failed: ${outcome.error}`);
  const { raw, latencyMs, model, usage } = outcome.result;
  console.log(`latency ${latencyMs.toFixed(0)} ms, returned model ${model}`);
  console.log(`normalised usage ${JSON.stringify(usage)}`);
  console.log('raw response:');
  console.log(redact(JSON.stringify(raw, null, 2), apiKey));
}

function describeKeys(value) {
  if (value === undefined) return 'absent';
  if (Array.isArray(value)) return `array of ${value.length}`;
  if (value && typeof value === 'object') return `object keyed ${JSON.stringify(Object.keys(value))}`;
  return `${typeof value} ${JSON.stringify(value)}`;
}

function checklist(questions, jev, llm, mock) {
  const lines = [];
  const jevRaw = jev.result?.raw;
  const llmRaw = llm.result?.raw;
  if (jevRaw) {
    const n = normalise(() => normaliseJev(questions, jevRaw));
    lines.push(`1  Jev answer shape: ${n.ok ? 'accepted by normaliseJev' : `REJECTED, ${n.error}`}`);
    lines.push(`   answer keys: ${JSON.stringify(Object.fromEntries(Object.entries(jevRaw.answers ?? {}).map(([id, a]) => [id, Object.keys(a ?? {})])))}`);
    lines.push(`1a Score probabilities: ${describeKeys(jevRaw.answers?.blast_radius?.probabilities)} (expected object keyed ["0","1","2","3"])`);
    lines.push(`2  Jev usage fields: ${describeKeys(jevRaw.usage)}; cost ${typeof jevRaw.usage?.cost === 'number' ? 'present' : 'MISSING'}`);
    if (n.ok) lines.push(`   normalised: ${JSON.stringify(n.value)}`);
  } else {
    lines.push(`1-2 Jev: no response (${jev.error})`);
  }
  if (llmRaw) {
    const n = normalise(() => normaliseLlm(questions, llm.result.text));
    lines.push(`3  Chat usage fields: ${describeKeys(llmRaw.usage)}; cost ${typeof llmRaw.usage?.cost === 'number' ? 'present' : 'MISSING'}`);
    const schema = mock ? 'Strict json_schema: not checked (mock, no request sent)' : 'Strict json_schema accepted (no 400)';
    lines.push(`5  ${schema}; output ${n.ok ? 'accepted by normaliseLlm' : `REJECTED, ${n.error}`}`);
    if (n.ok) lines.push(`   normalised: ${JSON.stringify(n.value)}`);
  } else {
    lines.push(`3,5 LLM: no response (${llm.error})`);
  }
  lines.push(`4  Returned models: jev ${jev.result?.model ?? 'n/a'}, llm ${llm.result?.model ?? 'n/a'}`);
  return lines;
}

async function main() {
  const mock = process.argv.includes('--mock');
  const s = settings(mock);
  const questions = JSON.parse(readFileSync('config/questions.json', 'utf8'));
  const base = { state: STATE, questions, apiKey: s.apiKey };
  console.log(mock ? 'MOCK smoke test: no model is called.' : 'Live smoke test: 2 paid calls.');
  const jev = await attempt(() => s.jev({ ...base, model: s.jevModel }));
  printCall('Jev', s.jevModel, jev, s.apiKey);
  const llm = await attempt(() => s.llm({ ...base, model: s.llmModel, settings: s.llmSettings }));
  printCall('LLM', s.llmModel, llm, s.apiKey);
  console.log(`\n=== Checklist (plan.md section 5)${mock ? ' - MOCK: nothing below was checked against OpenRouter' : ''} ===`);
  for (const line of checklist(questions, jev, llm, mock)) console.log(redact(line, s.apiKey));
  if (jev.error || llm.error) process.exitCode = 1;
}

main().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
