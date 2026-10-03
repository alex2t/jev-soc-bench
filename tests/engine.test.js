import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerSchema, normaliseJev, normaliseLlm, isCorrect, SchemaError } from '../src/engine.js';

const questions = JSON.parse(readFileSync('config/questions.json', 'utf8'));

/** A Jev response in the shape documented in plan.md section 5 (unverified until M2). */
function jevRaw(overrides = {}) {
  return {
    model: 'typesafe/jev-1.13',
    answers: {
      queue: {
        type: 'choice',
        choice: 'cloud_iam',
        confidence: 0.93,
        probabilities: { cloud_iam: 0.95, network_ddos: 0.01, endpoint_malware: 0.02, benign_noise: 0.02 },
      },
      quarantine: { type: 'noul', noul: 0.91 },
      blast_radius: {
        type: 'score',
        score: 2.84,
        confidence: 0.81,
        probabilities: { 0: 0.0, 1: 0.02, 2: 0.12, 3: 0.86 },
      },
      ...overrides,
    },
  };
}

function llmText(overrides = {}) {
  return JSON.stringify({ queue: 'endpoint_malware', quarantine: 0.8, blast_radius: 2.2, ...overrides });
}

function assertSchemaError(fn, pattern) {
  assert.throws(fn, err => {
    assert.ok(err instanceof SchemaError, `expected SchemaError, got ${err}`);
    assert.equal(err.kind, 'schema_error');
    assert.match(err.message, pattern);
    return true;
  });
}

describe('answerSchema', () => {
  test('builds a strict schema from config/questions.json', () => {
    assert.deepEqual(answerSchema(questions), {
      type: 'object',
      properties: {
        queue: { type: 'string', enum: ['cloud_iam', 'network_ddos', 'endpoint_malware', 'benign_noise'] },
        quarantine: { type: 'number', minimum: 0, maximum: 1 },
        blast_radius: { type: 'number', minimum: 0, maximum: 3 },
      },
      required: ['queue', 'quarantine', 'blast_radius'],
      additionalProperties: false,
    });
  });

  test('works on any question IDs, as batched questions need', () => {
    const schema = answerSchema({ a0__queue: questions.queue, a1__queue: questions.queue });
    assert.deepEqual(schema.required, ['a0__queue', 'a1__queue']);
  });

  test('rejects an unknown question type', () => {
    assert.throws(() => answerSchema({ x: { type: 'rank', criteria: [] } }), /unknown question type rank/);
  });
});

describe('normaliseJev', () => {
  test('normalises a valid response', () => {
    assert.deepEqual(normaliseJev(questions, jevRaw()), {
      queue: {
        value: 'cloud_iam',
        confidence: 0.93,
        probabilities: { cloud_iam: 0.95, network_ddos: 0.01, endpoint_malware: 0.02, benign_noise: 0.02 },
      },
      quarantine: { value: 0.91 },
      blast_radius: { value: 2.84, level: 3, confidence: 0.81, probabilities: { 0: 0.0, 1: 0.02, 2: 0.12, 3: 0.86 } },
    });
  });

  test('derives the blast_radius level from the argmax, not by rounding the decimal', () => {
    const lowDecimal = jevRaw({
      blast_radius: { type: 'score', score: 2.41, confidence: 0.5, probabilities: { 0: 0.1, 1: 0.1, 2: 0.1, 3: 0.7 } },
    });
    assert.equal(normaliseJev(questions, lowDecimal).blast_radius.level, 3);
    const highDecimal = jevRaw({
      blast_radius: { type: 'score', score: 2.6, confidence: 0.5, probabilities: { 0: 0.0, 1: 0.0, 2: 0.6, 3: 0.4 } },
    });
    assert.equal(normaliseJev(questions, highDecimal).blast_radius.level, 2);
  });

  test('breaks an argmax tie towards the lower level', () => {
    const tie = jevRaw({
      blast_radius: { type: 'score', score: 1.5, confidence: 0.5, probabilities: { 0: 0.0, 1: 0.5, 2: 0.5, 3: 0.0 } },
    });
    assert.equal(normaliseJev(questions, tie).blast_radius.level, 1);
  });

  test('accepts probabilities that sum within 1 +/- 0.02', () => {
    const raw = jevRaw();
    raw.answers.queue.probabilities = { cloud_iam: 0.965, network_ddos: 0.01, endpoint_malware: 0.02, benign_noise: 0.02 };
    assert.equal(normaliseJev(questions, raw).queue.value, 'cloud_iam');
  });

  const invalid = [
    ['answers object missing', () => ({ model: 'x' }), /answers: missing/],
    ['a question unanswered', () => { const r = jevRaw(); delete r.answers.quarantine; return r; }, /quarantine: answer missing/],
    ['an answer to a question not asked', () => jevRaw({ severity: { type: 'noul', noul: 1 } }), /severity: answer for a question that was not asked/],
    ['wrong answer type', () => jevRaw({ quarantine: { type: 'score', score: 1 } }), /quarantine: type "score", expected noul/],
    ['choice not among the options', () => { const r = jevRaw(); r.answers.queue.choice = 'phishing'; return r; }, /queue: choice "phishing"/],
    ['choice confidence missing', () => { const r = jevRaw(); delete r.answers.queue.confidence; return r; }, /queue: confidence must be/],
    ['probabilities missing', () => { const r = jevRaw(); delete r.answers.queue.probabilities; return r; }, /queue: probabilities missing/],
    ['probabilities missing an option', () => { const r = jevRaw(); delete r.answers.queue.probabilities.benign_noise; return r; }, /queue: probabilities must cover/],
    ['probabilities summing to 0.95', () => { const r = jevRaw(); r.answers.queue.probabilities.cloud_iam = 0.90; return r; }, /queue: probabilities sum to/],
    ['a probability outside 0 to 1',() => { const r = jevRaw(); r.answers.blast_radius.probabilities = { 0: -0.5, 1: 0, 2: 0, 3: 1.5 }; return r; }, /blast_radius: probabilities.0 must be/],
    ['noul above 1', () => jevRaw({ quarantine: { type: 'noul', noul: 1.2 } }), /quarantine: noul must be a number from 0 to 1/],
    ['noul as a boolean', () => jevRaw({ quarantine: { type: 'noul', noul: true } }), /quarantine: noul must be a number/],
    ['score above the last level', () => { const r = jevRaw(); r.answers.blast_radius.score = 3.2; return r; }, /blast_radius: score must be a number from 0 to 3/],
    ['score as a string', () => { const r = jevRaw(); r.answers.blast_radius.score = '2'; return r; }, /blast_radius: score must be a number/],
  ];
  for (const [name, build, pattern] of invalid) {
    test(`rejects ${name}`, () => assertSchemaError(() => normaliseJev(questions, build()), pattern));
  }
});

describe('normaliseLlm', () => {
  test('normalises valid JSON text with null confidence and probabilities', () => {
    assert.deepEqual(normaliseLlm(questions, llmText()), {
      queue: { value: 'endpoint_malware', confidence: null, probabilities: null },
      quarantine: { value: 0.8 },
      blast_radius: { value: 2.2, level: 2, confidence: null, probabilities: null },
    });
  });

  test('derives the blast_radius level by rounding', () => {
    const level = v => normaliseLlm(questions, llmText({ blast_radius: v })).blast_radius.level;
    assert.equal(level(2.49), 2);
    assert.equal(level(2.5), 3);
    assert.equal(level(0), 0);
    assert.equal(level(3), 3);
  });

  const invalid = [
    ['null content', null, /content: no message content/],
    ['prose instead of JSON', 'The alert looks malicious.', /content: not valid JSON/],
    ['a JSON array', '[]', /content: not a JSON object/],
    ['JSON null', 'null', /content: not a JSON object/],
    ['a missing question', JSON.stringify({ queue: 'cloud_iam', quarantine: 0.2 }), /blast_radius: answer missing/],
    ['an extra property', llmText({ verdict: 'malicious' }), /verdict: answer for a question that was not asked/],
    ['a queue outside the enum', llmText({ queue: 'phishing' }), /queue: choice "phishing"/],
    ['quarantine as a boolean', llmText({ quarantine: true }), /quarantine: noul must be a number/],
    ['quarantine above 1', llmText({ quarantine: 1.5 }), /quarantine: noul must be/],
    ['a negative blast_radius', llmText({ blast_radius: -1 }), /blast_radius: score must be a number from 0 to 3/],
    ['blast_radius above 3', llmText({ blast_radius: 4 }), /blast_radius: score must be/],
  ];
  for (const [name, text, pattern] of invalid) {
    test(`rejects ${name}`, () => assertSchemaError(() => normaliseLlm(questions, text), pattern));
  }
});

describe('isCorrect', () => {
  const expected = { queue: 'cloud_iam', quarantine: true, blast_radius: 3 };

  test('marks every question correct and reports the blast_radius absolute error', () => {
    const result = isCorrect(normaliseJev(questions, jevRaw()), expected);
    assert.equal(result.queue, true);
    assert.equal(result.quarantine, true);
    assert.equal(result.blast_radius, true);
    assert.ok(Math.abs(result.blastAbsError - 0.16) < 1e-9);
  });

  test('marks a wrong queue and a wrong level as incorrect', () => {
    const result = isCorrect(normaliseLlm(questions, llmText()), expected);
    assert.equal(result.queue, false);
    assert.equal(result.blast_radius, false);
    assert.ok(Math.abs(result.blastAbsError - 0.8) < 1e-9);
  });

  test('cuts quarantine at 0.5 inclusive', () => {
    const at = v => isCorrect(normaliseLlm(questions, llmText({ quarantine: v })), expected).quarantine;
    assert.equal(at(0.5), true);
    assert.equal(at(0.49), false);
    const notThreat = { ...expected, quarantine: false };
    const atFalse = v => isCorrect(normaliseLlm(questions, llmText({ quarantine: v })), notThreat).quarantine;
    assert.equal(atFalse(0.49), true);
    assert.equal(atFalse(0.5), false);
  });
});
