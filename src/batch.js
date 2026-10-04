/**
 * Batched requests and the contamination design (plan.md section 13). Pure functions: question
 * flattening, answer splitting, batch membership, in-batch rotation and the size guard.
 */

import { seededRandom, shuffle } from './util.js';

export const MAX_BATCH_TOKENS = 24000;
const SHIFT_PER_REPEAT = 3;
const COMPANIONS = 4;

/** One copy of every question per alert, prefixed `a<i>__` and naming the alert's position. */
export function batchQuestions(questions, n) {
  const out = {};
  for (let i = 0; i < n; i++) {
    for (const [id, q] of Object.entries(questions)) {
      out[`a${i}__${id}`] = { ...q, instructions: `For alerts[${i}] only: ${q.instructions}` };
    }
  }
  return out;
}

/** Normalised answers to flattened questions -> one answer set per alert, in batch order. */
export function splitAnswers(normalisedFlat, n, questions) {
  return Array.from({ length: n }, (_, i) =>
    Object.fromEntries(Object.keys(questions).map(id => [id, normalisedFlat[`a${i}__${id}`]])));
}

/** The request state for alerts in batch order: their states only, never labels. */
export function batchState(alerts) {
  return { alerts: alerts.map(a => a.state) };
}

/** Rough token estimate (characters / 4) of what a request carries: state plus questions. */
export function estimateTokens(state, questions) {
  return Math.ceil((JSON.stringify(state).length + JSON.stringify(questions).length) / 4);
}

/** Throw before sending a batch whose estimated size is above MAX_BATCH_TOKENS. */
export function checkBatchSize(state, questions) {
  const tokens = estimateTokens(state, questions);
  if (tokens > MAX_BATCH_TOKENS) throw new Error(`batch of ${state.alerts.length} alerts is about ${tokens} tokens, above ${MAX_BATCH_TOKENS}`);
  return tokens;
}

/** Split alerts into batches of `size` after a seeded shuffle; the last batch may be smaller. */
export function makeBatches(alerts, size, seed) {
  const order = shuffle(alerts, seededRandom(`batches|${seed}`));
  return Array.from({ length: Math.ceil(order.length / size) }, (_, b) => order.slice(b * size, (b + 1) * size));
}

/** Batch order for a repeat (1-based): repeat r moves every alert (r - 1) x 3 positions later. */
export function rotate(batch, repeat) {
  const shift = ((repeat - 1) * SHIFT_PER_REPEAT) % batch.length;
  return batch.map((_, i) => batch[(i - shift + batch.length) % batch.length]);
}

/**
 * Contamination design: each adversarial alert is a source; its companions are 4 clear alerts
 * not labelled benign_noise, taken in consecutive groups from a seeded shuffle (wrapping, so a
 * companion is reused only when the pool is smaller than sources x 4). The exposed batch is the
 * companions with the source inserted at a seeded position; the control is the companions alone.
 */
export function contaminationPairs(alerts, seed) {
  const sources = alerts.filter(a => a.difficulty === 'adversarial');
  const pool = shuffle(alerts.filter(a => a.difficulty === 'clear' && a.expected.queue !== 'benign_noise'), seededRandom(`companions|${seed}`));
  if (pool.length < COMPANIONS) throw new Error(`need at least ${COMPANIONS} clear non-benign alerts, found ${pool.length}`);
  const rand = seededRandom(`source-position|${seed}`);
  return sources.map((source, k) => {
    const companions = Array.from({ length: COMPANIONS }, (_, j) => pool[(k * COMPANIONS + j) % pool.length]);
    const position = Math.floor(rand() * (COMPANIONS + 1));
    const exposed = [...companions.slice(0, position), source, ...companions.slice(position)];
    return { source, sourcePosition: position, companions, exposed, control: companions };
  });
}
