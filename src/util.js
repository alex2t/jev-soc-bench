/** Small shared helpers: hashing, seeded randomness, environment checks. */

import { createHash } from 'node:crypto';

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** Deterministic PRNG (mulberry32) seeded from any string. Returns a function giving [0, 1). */
export function seededRandom(seed) {
  let a = Number.parseInt(sha256(seed).slice(0, 8), 16);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Copy of `items` in a random order drawn from `rand` (Fisher-Yates). */
export function shuffle(items, rand) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Nearest-rank percentile (p in 0..100) of numbers; null for an empty list. */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

/**
 * Run `worker(item, index)` over items with at most `limit` in flight. Before starting each
 * item, `shouldStop()` is asked; once it returns true no new item starts (in-flight ones finish).
 * Resolves to the number of items started.
 */
export async function runPool(items, limit, worker, shouldStop = () => false) {
  let next = 0;
  async function lane() {
    while (next < items.length && !shouldStop()) {
      const index = next++;
      await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return next;
}

/** Return the named variables, or throw naming every missing one (never a value). */
export function requireEnv(env, names) {
  const missing = names.filter(n => !env[n]);
  if (missing.length) throw new Error(`missing environment variable(s): ${missing.join(', ')}`);
  return Object.fromEntries(names.map(n => [n, env[n]]));
}
