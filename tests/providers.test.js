import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callJev, normaliseUsage } from '../src/providers/jev.js';
import { callLlm, SYSTEM } from '../src/providers/llm.js';
import { mockJev, mockLlm } from '../src/providers/mock.js';
import { answerSchema, normaliseJev, normaliseLlm } from '../src/engine.js';

const questions = JSON.parse(readFileSync('config/questions.json', 'utf8'));
const API_KEY = 'test-key-not-real';
const LABEL_FIELDS = ['expected', 'rationale', 'difficulty', 'tags'];

const alert = {
  id: 'SEC-0001',
  difficulty: 'clear',
  tags: ['cloud'],
  state: { alert_id: 'SEC-0001', source: 'AWS CloudTrail', source_ip: '198.51.100.44', details: 'IAM anomaly' },
  expected: { queue: 'cloud_iam', quarantine: true, blast_radius: 3 },
  rationale: 'Brute force followed by admin key creation.',
};

/** Fake fetch that records the request and answers with the given status and body. */
function fakeFetch(status, body) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { impl, calls };
}

function args(fetchImpl, model) {
  return { state: alert.state, questions, model, apiKey: API_KEY, fetchImpl };
}

function assertNoLabels(text) {
  for (const field of LABEL_FIELDS) assert.ok(!text.includes(`"${field}"`), `request contains ${field}`);
  assert.ok(!text.includes(alert.rationale), 'request contains the rationale text');
}

describe('callJev', () => {
  test('posts model, state and questions only, with the key in the Authorization header', async () => {
    const { impl, calls } = fakeFetch(200, { model: 'typesafe/jev-1.13-20260917', answers: {} });
    await callJev(args(impl, 'typesafe/jev-1.13'));
    const [{ url, options, body }] = calls;
    assert.equal(url, 'https://openrouter.ai/api/alpha/decisions');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, `Bearer ${API_KEY}`);
    assert.deepEqual(Object.keys(body).sort(), ['model', 'questions', 'state']);
    assert.deepEqual(body.state, alert.state);
    assert.deepEqual(body.questions, questions);
    assert.ok(!options.body.includes(API_KEY), 'key in request body');
    assertNoLabels(options.body);
  });

  test('returns raw, latency, the returned model ID and normalised usage', async () => {
    const raw = { model: 'typesafe/jev-1.13-20260917', answers: {}, usage: { input_tokens: 612, cost: 0.0000257 } };
    const result = await callJev(args(fakeFetch(200, raw).impl, 'typesafe/jev-1.13'));
    assert.equal(result.raw, raw);
    assert.equal(result.model, 'typesafe/jev-1.13-20260917');
    assert.deepEqual(result.usage, { inputTokens: 612, outputTokens: null, costUsd: 0.0000257 });
    assert.ok(result.latencyMs >= 0);
  });

  test('falls back to the requested model only when the response has none', async () => {
    const result = await callJev(args(fakeFetch(200, { answers: {} }).impl, 'typesafe/jev-1.13'));
    assert.equal(result.model, 'typesafe/jev-1.13');
  });

  test('throws an http_error with status and latency, and no key or upstream body', async () => {
    const { impl } = fakeFetch(401, { error: { message: `bad key ${API_KEY}` } });
    await assert.rejects(callJev(args(impl, 'typesafe/jev-1.13')), err => {
      assert.equal(err.message, 'jev HTTP 401');
      assert.equal(err.kind, 'http_error');
      assert.equal(err.status, 401);
      assert.ok(err.latencyMs >= 0);
      assert.ok(!JSON.stringify({ ...err, message: err.message }).includes(API_KEY));
      return true;
    });
  });
});

describe('callLlm', () => {
  const chat = content => ({ model: 'openai/gpt-4o-mini', choices: [{ message: { content } }], usage: { prompt_tokens: 700, completion_tokens: 25 } });

  test('sends the strict schema, temperature 0 and only state and questions as user content', async () => {
    const { impl, calls } = fakeFetch(200, chat('{}'));
    await callLlm(args(impl, 'openai/gpt-4o-mini'));
    const [{ url, options, body }] = calls;
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(options.headers.Authorization, `Bearer ${API_KEY}`);
    assert.equal(body.model, 'openai/gpt-4o-mini');
    assert.equal(body.temperature, 0);
    assert.deepEqual(body.messages[0], { role: 'system', content: SYSTEM });
    assert.equal(body.messages[1].role, 'user');
    const userContent = JSON.parse(body.messages[1].content);
    assert.deepEqual(Object.keys(userContent).sort(), ['questions', 'state']);
    assert.deepEqual(userContent.state, alert.state);
    assert.deepEqual(body.response_format, {
      type: 'json_schema',
      json_schema: { name: 'decisions', strict: true, schema: answerSchema(questions) },
    });
    assert.deepEqual(body.provider, { require_parameters: true });
    assert.ok(!options.body.includes(API_KEY), 'key in request body');
    assertNoLabels(options.body);
  });

  test('returns the message text and usage without cost as unavailable', async () => {
    const result = await callLlm(args(fakeFetch(200, chat('{"queue":"cloud_iam"}')).impl, 'openai/gpt-4o-mini'));
    assert.equal(result.text, '{"queue":"cloud_iam"}');
    assert.deepEqual(result.usage, { inputTokens: 700, outputTokens: 25, costUsd: null });
  });

  test('returns null text when the response has no message content', async () => {
    const result = await callLlm(args(fakeFetch(200, { choices: [] }).impl, 'openai/gpt-4o-mini'));
    assert.equal(result.text, null);
  });

  test('throws an http_error on a 400', async () => {
    await assert.rejects(callLlm(args(fakeFetch(400, {}).impl, 'openai/gpt-4o-mini')),
      { message: 'llm HTTP 400', kind: 'http_error', status: 400 });
  });
});

describe('provider error classification (F-8)', () => {
  /** Fetch that never answers and rejects when the request's own timeout signal fires. */
  const hangingFetch = async (url, { signal }) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));

  /** Fetch whose response is 200 but whose body read fails with the given error. */
  const failingBody = error => async () => ({ ok: true, status: 200, json: async () => { throw error; } });

  const timeoutError = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');

  const cases = [
    ['jev', callJev, 'typesafe/jev-1.13'],
    ['llm', callLlm, 'openai/gpt-4o-mini'],
  ];
  for (const [name, call, model] of cases) {
    test(`${name}: a request that exceeds timeoutMs is a timeout with latency`, async () => {
      const started = Date.now();
      await assert.rejects(call({ ...args(hangingFetch, model), timeoutMs: 30 }), err => {
        assert.equal(err.kind, 'timeout');
        assert.equal(err.message, `${name} timeout after 30 ms`);
        assert.ok(err.latencyMs >= 25 && err.latencyMs < 2000, `latencyMs ${err.latencyMs}`);
        return true;
      });
      assert.ok(Date.now() - started < 2000);
    });

    test(`${name}: a timeout while reading the body is a timeout`, async () => {
      await assert.rejects(call(args(failingBody(timeoutError()), model)), { kind: 'timeout' });
    });

    test(`${name}: a refused or failed connection is an http_error with no status (F-19)`, async () => {
      const refused = async () => { throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 203.0.113.1:443') }); };
      await assert.rejects(call(args(refused, model)), err => {
        assert.equal(err.kind, 'http_error');
        assert.equal(err.status, null);
        assert.equal(err.message, `${name} network error`);
        assert.ok(err.latencyMs >= 0);
        assert.ok(!err.message.includes('203.0.113.1'), 'upstream detail leaked');
        return true;
      });
    });

    test(`${name}: a connection dropped while reading the body is an http_error (F-19)`, async () => {
      const dropped = new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
      await assert.rejects(call(args(failingBody(dropped), model)),
        { kind: 'http_error', status: null, message: `${name} network error` });
    });

    test(`${name}: other errors, such as a bad URL, propagate unchanged and unclassified`, async () => {
      const badUrl = async () => { throw new TypeError('Failed to parse URL from not a url'); };
      await assert.rejects(call(args(badUrl, model)), err => {
        assert.equal(err.message, 'Failed to parse URL from not a url');
        assert.equal(err.kind, undefined);
        return true;
      });
    });

    test(`${name}: a body that is not JSON is a schema_error with latency`, async () => {
      await assert.rejects(call(args(failingBody(new SyntaxError('Unexpected token <')), model)), err => {
        assert.equal(err.kind, 'schema_error');
        assert.equal(err.message, `${name} response body is not JSON`);
        assert.ok(err.latencyMs >= 0);
        assert.ok(!err.message.includes('Unexpected token'), 'upstream detail leaked');
        return true;
      });
    });
  }
});

describe('normaliseUsage', () => {
  test('returns null when usage is absent, and never turns a missing cost into 0', () => {
    assert.equal(normaliseUsage(undefined), null);
    assert.deepEqual(normaliseUsage({ prompt_tokens: 5 }), { inputTokens: 5, outputTokens: null, costUsd: null });
    assert.equal(normaliseUsage({ cost: '0.01' }).costUsd, null);
    assert.equal(normaliseUsage({ cost: 0 }).costUsd, 0);
  });
});

describe('mock providers', () => {
  const alerts = Array.from({ length: 40 }, (_, i) => ({ alert_id: `SEC-${String(i + 1).padStart(4, '0')}` }));

  async function normalisedRun(provider, repeat) {
    const call = provider === 'jev' ? mockJev : mockLlm;
    const out = [];
    for (const state of alerts) {
      const r = await call({ state, questions, repeat });
      out.push(provider === 'jev' ? normaliseJev(questions, r.raw) : normaliseLlm(questions, r.text));
    }
    return out;
  }

  test('produce answers the engine accepts, over many alerts and repeats', async () => {
    for (const repeat of [1, 2, 3]) {
      assert.equal((await normalisedRun('jev', repeat)).length, 40);
      assert.equal((await normalisedRun('llm', repeat)).length, 40);
    }
  });

  test('are deterministic for the same provider, alert and repeat', async () => {
    const state = alerts[0];
    assert.deepEqual(await mockJev({ state, questions, repeat: 2 }), await mockJev({ state, questions, repeat: 2 }));
    assert.deepEqual(await mockLlm({ state, questions, repeat: 2 }), await mockLlm({ state, questions, repeat: 2 }));
  });

  test('differ between providers and between repeats', async () => {
    const queues = run => run.map(a => a.queue.value).join(',');
    const jev1 = await normalisedRun('jev', 1);
    const llm1 = await normalisedRun('llm', 1);
    assert.notEqual(queues(jev1), queues(llm1));
    assert.notEqual(queues(jev1), queues(await normalisedRun('jev', 2)));
    // Independent seeds, not one random stream read two ways: quarantine values must not track.
    const tracking = jev1.filter((a, i) => Math.abs(a.quarantine.value - llm1[i].quarantine.value) < 0.01);
    assert.ok(tracking.length < 10, `${tracking.length} of 40 quarantine values track across providers`);
  });

  test('never give the same answer to a question for every alert', async () => {
    for (const provider of ['jev', 'llm']) {
      const run = await normalisedRun(provider, 1);
      for (const id of Object.keys(questions)) {
        const distinct = new Set(run.map(a => a[id].value));
        assert.ok(distinct.size > 1, `${provider} ${id} constant`);
      }
      const levels = new Set(run.map(a => a.blast_radius.level));
      assert.ok(levels.size > 1, `${provider} blast_radius level constant`);
    }
    const confidences = new Set((await normalisedRun('jev', 1)).map(a => a.queue.confidence));
    assert.ok(confidences.size > 1, 'jev queue confidence constant');
  });

  test('report model MOCK and cost as unavailable, never 0', async () => {
    for (const call of [mockJev, mockLlm]) {
      const r = await call({ state: alerts[0], questions });
      assert.equal(r.model, 'MOCK');
      assert.equal(r.raw.model, 'MOCK');
      assert.ok(!('cost' in r.raw.usage));
      assert.equal(r.usage.costUsd, null);
    }
  });

  test('vary latency across alerts', async () => {
    const latencies = new Set();
    for (const state of alerts) latencies.add((await mockJev({ state, questions })).latencyMs);
    assert.ok(latencies.size > 1);
  });

  test('need an alert_id to seed on', async () => {
    await assert.rejects(mockJev({ state: {}, questions }), /needs state.alert_id/);
  });
});
