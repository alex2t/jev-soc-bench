import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decide, checkPolicy } from '../src/policy.js';

const policy = JSON.parse(readFileSync('config/policy.json', 'utf8'));

/** Normalised answers; confidence null mimics the LLM, a number mimics Jev. */
function answers({ queue = 'cloud_iam', confidence = 0.9, quarantine = 0.5, level = 2 } = {}) {
  return {
    queue: { value: queue, confidence, probabilities: null },
    quarantine: { value: quarantine },
    blast_radius: { value: level, level, confidence: null, probabilities: null },
  };
}

const benign = { queue: 'benign_noise', quarantine: 0.05, level: 0 };

describe('config/policy.json', () => {
  test('holds the thresholds from plan.md section 6', () => {
    assert.deepEqual(policy, { minQueueConfidence: 0.6, autoQuarantineAt: 0.9, autoCloseBelow: 0.1 });
    checkPolicy(policy);
  });
});

describe('checkPolicy', () => {
  for (const name of ['minQueueConfidence', 'autoQuarantineAt', 'autoCloseBelow']) {
    test(`rejects a missing ${name}`, () => {
      const bad = { ...policy };
      delete bad[name];
      assert.throws(() => checkPolicy(bad), new RegExp(`policy.${name} must be`));
    });
  }

  test('rejects a threshold given as a string or outside 0..1', () => {
    assert.throws(() => checkPolicy({ ...policy, autoQuarantineAt: '0.9' }), /autoQuarantineAt/);
    assert.throws(() => checkPolicy({ ...policy, autoCloseBelow: -0.1 }), /autoCloseBelow/);
    assert.throws(() => checkPolicy({ ...policy, minQueueConfidence: 60 }), /minQueueConfidence/);
  });

  test('decide refuses to run with an invalid policy', () => {
    assert.throws(() => decide(answers(), {}), /policy.minQueueConfidence/);
  });
});

describe('decide', () => {
  test('rule 1: low queue confidence goes to analyst review', () => {
    assert.deepEqual(decide(answers({ confidence: 0.59 }), policy),
      { action: 'analyst_review', reason: 'low_queue_confidence', queue: 'cloud_iam' });
  });

  test('rule 1 takes precedence over a quarantine above the threshold', () => {
    assert.equal(decide(answers({ confidence: 0.4, quarantine: 0.99 }), policy).reason, 'low_queue_confidence');
  });

  test('rule 1 takes precedence over an otherwise auto-closable alert', () => {
    assert.equal(decide(answers({ ...benign, confidence: 0.4 }), policy).reason, 'low_queue_confidence');
  });

  test('rule 1 does not fire at exactly the minimum confidence', () => {
    assert.equal(decide(answers({ confidence: 0.6 }), policy).reason, 'default');
  });

  test('rule 1 never fires without a confidence (LLM)', () => {
    assert.equal(decide(answers({ confidence: null, quarantine: 0.95 }), policy).action, 'auto_quarantine');
    assert.equal(decide(answers({ ...benign, confidence: null }), policy).action, 'auto_close');
  });

  test('rule 2: quarantine at or above the threshold auto-quarantines', () => {
    assert.deepEqual(decide(answers({ quarantine: 0.9 }), policy),
      { action: 'auto_quarantine', reason: 'quarantine_threshold', queue: 'cloud_iam' });
    assert.equal(decide(answers({ quarantine: 0.89 }), policy).action, 'analyst_review');
  });

  test('rule 2 applies whatever the queue, including benign_noise', () => {
    assert.equal(decide(answers({ ...benign, quarantine: 0.95 }), policy).action, 'auto_quarantine');
  });

  test('rule 3: benign, low quarantine and level 0 auto-closes, inclusive at the threshold', () => {
    assert.deepEqual(decide(answers(benign), policy),
      { action: 'auto_close', reason: 'benign_low_risk', queue: 'benign_noise' });
    assert.equal(decide(answers({ ...benign, quarantine: 0.1 }), policy).action, 'auto_close');
  });

  test('rule 3 needs all three conditions', () => {
    assert.equal(decide(answers({ ...benign, quarantine: 0.11 }), policy).action, 'analyst_review');
    assert.equal(decide(answers({ ...benign, queue: 'network_ddos' }), policy).action, 'analyst_review');
    assert.equal(decide(answers({ ...benign, level: 1 }), policy).action, 'analyst_review');
  });

  test('rule 4: everything else goes to analyst review in the chosen queue', () => {
    assert.deepEqual(decide(answers({ queue: 'endpoint_malware', quarantine: 0.5 }), policy),
      { action: 'analyst_review', reason: 'default', queue: 'endpoint_malware' });
  });
});
