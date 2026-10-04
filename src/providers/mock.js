/**
 * Deterministic fake providers for tests, `bench:mock` and dashboard work.
 * Answers are seeded on provider, alert ID, repeat and question ID, so providers and repeats
 * differ. Raw shapes match the real providers; `usage` has no `cost`, so cost is unavailable.
 */

import { seededRandom } from '../util.js';
import { normaliseUsage } from './jev.js';

const round = (x, digits = 4) => Number(x.toFixed(digits));

/**
 * Seeded on the alert a question is about: `state.alert_id` for a single alert, or
 * `state.alerts[i].alert_id` for a batched question `a<i>__<id>` (section 13), so a batched mock
 * answer equals the single-alert one and mock runs show no batch effect.
 */
function randomFor(provider, state, repeat, questionId) {
  const batched = /^a(\d+)__(.+)$/.exec(questionId);
  const alertId = batched ? state?.alerts?.[Number(batched[1])]?.alert_id : state?.alert_id;
  if (!alertId) throw new Error(`mock provider needs ${batched ? `state.alerts[${batched[1]}].alert_id` : 'state.alert_id'}`);
  return seededRandom(`${provider}|${alertId}|${repeat}|${batched ? batched[2] : questionId}`);
}

/** Probabilities over keys, rounded, with the rounding remainder on the largest so they sum to 1. */
function distribution(keys, rand) {
  const weights = keys.map(() => rand() ** 3);
  const total = weights.reduce((s, w) => s + w, 0);
  const probs = weights.map(w => round(w / total));
  const top = probs.indexOf(Math.max(...probs));
  probs[top] = round(probs[top] + 1 - probs.reduce((s, p) => s + p, 0));
  return Object.fromEntries(keys.map((k, i) => [k, probs[i]]));
}

function argmax(probabilities) {
  return Object.entries(probabilities).reduce((best, e) => (e[1] > best[1] ? e : best))[0];
}

function jevAnswer(q, rand) {
  if (q.type === 'noul') return { type: 'noul', noul: round(rand()) };
  const keys = q.type === 'choice' ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
  const probabilities = distribution(keys, rand);
  const confidence = probabilities[argmax(probabilities)];
  if (q.type === 'choice') return { type: 'choice', choice: argmax(probabilities), confidence, probabilities };
  const score = round(keys.reduce((s, k) => s + Number(k) * probabilities[k], 0));
  return { type: 'score', score, confidence, probabilities };
}

function llmValue(q, rand) {
  if (q.type === 'choice') {
    const keys = Object.keys(q.criteria);
    return keys[Math.floor(rand() * keys.length)];
  }
  if (q.type === 'noul') return round(rand(), 2);
  return round(rand() * (q.criteria.length - 1), 2);
}

function latency(provider, state, repeat, min, spread) {
  const key = state.alerts ? { alert_id: state.alerts.map(a => a.alert_id).join(',') } : state;
  return round(min + randomFor(provider, key, repeat, '__latency')() * spread, 1);
}

export async function mockJev({ state, questions, repeat = 1 }) {
  const answers = Object.fromEntries(Object.entries(questions)
    .map(([id, q]) => [id, jevAnswer(q, randomFor('jev', state, repeat, id))]));
  const raw = { model: 'MOCK', answers, usage: { input_tokens: 600, output_tokens: 0 } };
  return { raw, latencyMs: latency('jev', state, repeat, 150, 250), model: 'MOCK', usage: normaliseUsage(raw.usage) };
}

export async function mockLlm({ state, questions, repeat = 1 }) {
  const values = Object.fromEntries(Object.entries(questions)
    .map(([id, q]) => [id, llmValue(q, randomFor('llm', state, repeat, id))]));
  const text = JSON.stringify(values);
  const raw = {
    model: 'MOCK',
    choices: [{ message: { role: 'assistant', content: text } }],
    usage: { prompt_tokens: 700, completion_tokens: 30 },
  };
  return { raw, text, latencyMs: latency('llm', state, repeat, 400, 900), model: 'MOCK', usage: normaliseUsage(raw.usage) };
}
