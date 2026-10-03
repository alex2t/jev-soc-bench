import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { seededRandom, requireEnv, sha256 } from '../src/util.js';

describe('sha256', () => {
  test('matches the known digest of "abc"', () => {
    assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('seededRandom', () => {
  test('repeats the same sequence for the same seed and differs for another seed', () => {
    const seq = seed => { const r = seededRandom(seed); return [r(), r(), r()]; };
    assert.deepEqual(seq('a'), seq('a'));
    assert.notDeepEqual(seq('a'), seq('b'));
  });

  test('stays in [0, 1) and spreads over the range', () => {
    const r = seededRandom('spread');
    const values = Array.from({ length: 1000 }, r);
    assert.ok(values.every(v => v >= 0 && v < 1));
    assert.ok(values.some(v => v < 0.1) && values.some(v => v > 0.9));
  });
});

describe('requireEnv', () => {
  const env = { OPENROUTER_API_KEY: 'secret-value', JEV_MODEL: 'typesafe/jev-1.13', LLM_MODEL: 'openai/gpt-4o-mini' };
  const names = ['OPENROUTER_API_KEY', 'JEV_MODEL', 'LLM_MODEL'];

  test('returns the variables when all are set', () => {
    assert.deepEqual(requireEnv(env, names), env);
  });

  for (const name of names) {
    test(`stops when ${name} is missing, naming it`, () => {
      const partial = { ...env };
      delete partial[name];
      assert.throws(() => requireEnv(partial, names), new RegExp(`missing environment variable\\(s\\): ${name}$`));
    });
  }

  test('treats an empty value as missing and lists every missing name, never a value', () => {
    assert.throws(() => requireEnv({ OPENROUTER_API_KEY: '', JEV_MODEL: 'jev-value' }, names),
      { message: 'missing environment variable(s): OPENROUTER_API_KEY, LLM_MODEL' });
  });
});
