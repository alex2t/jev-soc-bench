/** Schema building, validation and normalisation of provider answers. */

const PROBABILITY_TOLERANCE = 0.02;

export class SchemaError extends Error {
  kind = 'schema_error';
}

function fail(id, message) {
  throw new SchemaError(`${id}: ${message}`);
}

function scoreMax(question) {
  return question.criteria.length - 1;
}

/** Keys a choice question may answer, or score levels as strings ("0".."n-1"). */
function optionKeys(question) {
  if (question.type === 'choice') return Object.keys(question.criteria);
  if (question.type === 'score') return question.criteria.map((_, i) => String(i));
  throw new Error(`question type ${question.type} has no options`);
}

/** Strict JSON schema the LLM must fill: one property per question. */
export function answerSchema(questions) {
  const properties = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === 'choice') properties[id] = { type: 'string', enum: optionKeys(q) };
    else if (q.type === 'noul') properties[id] = { type: 'number', minimum: 0, maximum: 1 };
    else if (q.type === 'score') properties[id] = { type: 'number', minimum: 0, maximum: scoreMax(q) };
    else throw new Error(`unknown question type ${q.type} for ${id}`);
  }
  return {
    type: 'object',
    properties,
    required: Object.keys(questions),
    additionalProperties: false,
  };
}

function checkNumber(id, field, value, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
    fail(id, `${field} must be a number from 0 to ${max}, got ${JSON.stringify(value)}`);
  }
}

function checkProbabilities(id, question, probabilities) {
  if (!probabilities || typeof probabilities !== 'object') fail(id, 'probabilities missing');
  if (Array.isArray(probabilities)) fail(id, 'probabilities must be an object keyed by option, got an array');
  const expected = optionKeys(question);
  const actual = Object.keys(probabilities);
  if (actual.length !== expected.length || !expected.every(k => k in probabilities)) {
    fail(id, `probabilities must cover exactly ${expected.join(', ')}`);
  }
  for (const k of expected) checkNumber(id, `probabilities.${k}`, probabilities[k], 1);
  const sum = expected.reduce((s, k) => s + probabilities[k], 0);
  if (Math.abs(sum - 1) > PROBABILITY_TOLERANCE) fail(id, `probabilities sum to ${sum}`);
}

/** Level with the highest probability; on a tie, the lowest level. */
function argmaxLevel(probabilities) {
  let best = 0;
  for (let i = 1; String(i) in probabilities; i++) {
    if (probabilities[String(i)] > probabilities[String(best)]) best = i;
  }
  return best;
}

function checkKnownIds(questions, answers) {
  for (const id of Object.keys(answers)) {
    if (!(id in questions)) fail(id, 'answer for a question that was not asked');
  }
}

function normaliseJevAnswer(id, q, a) {
  if (!a || typeof a !== 'object') fail(id, 'answer missing');
  if (a.type !== q.type) fail(id, `type ${JSON.stringify(a.type)}, expected ${q.type}`);
  if (q.type === 'noul') {
    checkNumber(id, 'noul', a.noul, 1);
    return { value: a.noul };
  }
  checkNumber(id, 'confidence', a.confidence, 1);
  checkProbabilities(id, q, a.probabilities);
  if (q.type === 'choice') {
    if (!optionKeys(q).includes(a.choice)) fail(id, `choice ${JSON.stringify(a.choice)} is not an option`);
    return { value: a.choice, confidence: a.confidence, probabilities: a.probabilities };
  }
  checkNumber(id, 'score', a.score, scoreMax(q));
  return {
    value: a.score,
    level: argmaxLevel(a.probabilities),
    confidence: a.confidence,
    probabilities: a.probabilities,
  };
}

/** Normalise a raw Jev response. Throws SchemaError on any missing or invalid answer. */
export function normaliseJev(questions, raw) {
  const answers = raw?.answers;
  if (!answers || typeof answers !== 'object') fail('answers', 'missing from response');
  checkKnownIds(questions, answers);
  return Object.fromEntries(
    Object.entries(questions).map(([id, q]) => [id, normaliseJevAnswer(id, q, answers[id])]));
}

function normaliseLlmAnswer(id, q, value) {
  if (value === undefined) fail(id, 'answer missing');
  if (q.type === 'choice') {
    if (!optionKeys(q).includes(value)) fail(id, `choice ${JSON.stringify(value)} is not an option`);
    return { value, confidence: null, probabilities: null };
  }
  if (q.type === 'noul') {
    checkNumber(id, 'noul', value, 1);
    return { value };
  }
  checkNumber(id, 'score', value, scoreMax(q));
  return { value, level: Math.round(value), confidence: null, probabilities: null };
}

/** Normalise the LLM's message text. Throws SchemaError on unparsable or invalid output. */
export function normaliseLlm(questions, text) {
  if (typeof text !== 'string') fail('content', 'no message content');
  let answers;
  try {
    answers = JSON.parse(text);
  } catch {
    fail('content', 'not valid JSON');
  }
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) fail('content', 'not a JSON object');
  checkKnownIds(questions, answers);
  return Object.fromEntries(
    Object.entries(questions).map(([id, q]) => [id, normaliseLlmAnswer(id, q, answers[id])]));
}

/** Compare a normalised answer set with the human labels of one alert. */
export function isCorrect(normalised, expected) {
  const blast = normalised.blast_radius;
  return {
    queue: normalised.queue.value === expected.queue,
    quarantine: (normalised.quarantine.value >= 0.5) === expected.quarantine,
    blast_radius: blast.level === expected.blast_radius,
    blastAbsError: Math.abs(blast.value - expected.blast_radius),
  };
}
