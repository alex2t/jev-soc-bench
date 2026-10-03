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

/** Return the named variables, or throw naming every missing one (never a value). */
export function requireEnv(env, names) {
  const missing = names.filter(n => !env[n]);
  if (missing.length) throw new Error(`missing environment variable(s): ${missing.join(', ')}`);
  return Object.fromEntries(names.map(n => [n, env[n]]));
}
