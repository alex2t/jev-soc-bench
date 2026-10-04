/** Dataset validation (plan.md section 4): IDs, labels, synthetic-only data, no label leakage. */

import { sha256 } from './util.js';

/** JSON with object keys sorted at every level, so layout and key order never change a hash. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const byId = alerts => [...alerts].sort((a, b) => a.id.localeCompare(b.id));

/** Fingerprint of what is sent to the models: each alert's ID and state (F-31). */
export function inputsSha256(dataset) {
  return sha256(canonical(byId(dataset.alerts).map(a => [a.id, a.state])));
}

/** Fingerprint of what answers are scored against: labels, injection targets and the reviewer (F-31). */
export function labelsSha256(dataset) {
  return sha256(canonical([dataset.labelledBy, byId(dataset.alerts).map(a => [a.id, a.expected, a.injectionTarget ?? null])]));
}

const DIFFICULTIES = ['clear', 'ambiguous', 'adversarial'];
const INJECTION_TAGS = ['prompt-injection', 'cross-alert-injection'];
const FORBIDDEN_KEYS = [
  'severity', 'verdict', 'is_malicious', 'malicious', 'label', 'labels', 'expected', 'priority',
  'risk', 'risk_score', 'classification', 'queue', 'quarantine', 'blast_radius', 'rationale',
  'injectiontarget',
];
const VERDICT_WORDS = /\b(malicious|benign|verdict|severity|false positive|true positive)\b/i;
const RFC5737 = ['192.0.2.', '198.51.100.', '203.0.113.'];
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const DOMAIN = /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|info|biz|co|xyz|dev|app|ru|cn)\b/gi;
const SYNTHETIC_DOMAIN = /(?:^|\.)example\.(?:com|net)$/i;

function strings(value) {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

function keysDeep(value) {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => [k, ...keysDeep(v)]);
}

function checkExpected(expected, questions) {
  const errors = [];
  if (!expected || typeof expected !== 'object') return ['expected missing'];
  if (!Object.keys(questions.queue.criteria).includes(expected.queue)) {
    errors.push(`expected.queue ${JSON.stringify(expected.queue)} is not an option`);
  }
  if (typeof expected.quarantine !== 'boolean') errors.push('expected.quarantine must be true or false');
  const maxLevel = questions.blast_radius.criteria.length - 1;
  if (!Number.isInteger(expected.blast_radius) || expected.blast_radius < 0 || expected.blast_radius > maxLevel) {
    errors.push(`expected.blast_radius must be an integer from 0 to ${maxLevel}`);
  }
  return errors;
}

/**
 * Snake_case label identifiers (queue keys and question IDs such as blast_radius). They cannot
 * occur in a real log by chance, so their presence gives the label away.
 */
function labelNames(questions) {
  return [...Object.keys(questions.queue.criteria), ...Object.keys(questions)].filter(k => k.includes('_'));
}

function checkState(state, tags, names) {
  if (!state || typeof state !== 'object') return ['state missing'];
  const errors = [];
  for (const key of keysDeep(state)) {
    if (FORBIDDEN_KEYS.includes(key.toLowerCase())) errors.push(`state has label-revealing key "${key}"`);
  }
  const text = strings(state).join('\n');
  for (const ip of text.match(IPV4) ?? []) {
    if (!RFC5737.some(prefix => ip.startsWith(prefix))) errors.push(`IP ${ip} is outside RFC 5737`);
  }
  for (const domain of text.match(DOMAIN) ?? []) {
    if (!SYNTHETIC_DOMAIN.test(domain)) errors.push(`domain ${domain} is not under example.com or example.net`);
  }
  const injected = tags.some(t => INJECTION_TAGS.includes(t));
  const word = text.match(VERDICT_WORDS);
  if (word && !injected) errors.push(`state contains verdict word "${word[0]}"`);
  for (const name of names) {
    if (!injected && new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(text)) {
      errors.push(`state contains label name "${name}"`);
    }
  }
  return errors;
}

/**
 * Injection-tagged alerts carry `injectionTarget: { queue, scope }`: the queue the injected text
 * pushes for, and whether it targets its own alert ("self") or neighbours in a batch ("others",
 * the cross-alert injections). Kept beside the labels, never in `state` (F-27).
 */
function checkInjectionTarget(alert, tags, questions) {
  const target = alert.injectionTarget;
  if (!tags.some(t => INJECTION_TAGS.includes(t))) {
    return target === undefined ? [] : ['injectionTarget is only allowed on injection-tagged alerts'];
  }
  if (!target || typeof target !== 'object') return ['injection-tagged alert needs injectionTarget'];
  const errors = [];
  if (!Object.keys(questions.queue.criteria).includes(target.queue)) {
    errors.push(`injectionTarget.queue ${JSON.stringify(target.queue)} is not an option`);
  }
  const scope = tags.includes('cross-alert-injection') ? 'others' : 'self';
  if (target.scope !== scope) errors.push(`injectionTarget.scope must be "${scope}"`);
  return errors;
}

function checkAlert(alert, questions) {
  const tags = Array.isArray(alert.tags) ? alert.tags : [];
  const errors = [];
  if (!/^SEC-\d{4}$/.test(alert.id ?? '')) errors.push(`id ${JSON.stringify(alert.id)} must look like SEC-0001`);
  if (alert.state?.alert_id !== alert.id) errors.push('state.alert_id must equal id');
  if (!DIFFICULTIES.includes(alert.difficulty)) errors.push(`difficulty ${JSON.stringify(alert.difficulty)} is unknown`);
  if (!Array.isArray(alert.tags) || !tags.every(t => typeof t === 'string')) errors.push('tags must be an array of strings');
  if (typeof alert.rationale !== 'string' || !alert.rationale) errors.push('rationale missing');
  return [...errors, ...checkExpected(alert.expected, questions), ...checkInjectionTarget(alert, tags, questions),
    ...checkState(alert.state, tags, labelNames(questions))];
}

/** Return every problem found, as "ID: message" strings. Empty means valid. */
export function checkDataset(dataset, questions) {
  const errors = [];
  if (dataset.labelledBy !== null && (typeof dataset.labelledBy !== 'string' || !dataset.labelledBy)) {
    errors.push('labelledBy must be null (draft) or the reviewer name');
  }
  if (!Array.isArray(dataset.alerts)) return [...errors, 'alerts must be an array'];
  const seen = new Set();
  for (const alert of dataset.alerts) {
    if (seen.has(alert.id)) errors.push(`${alert.id}: duplicate id`);
    seen.add(alert.id);
    errors.push(...checkAlert(alert, questions).map(e => `${alert.id}: ${e}`));
  }
  return errors;
}

function countBy(items, key) {
  const counts = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

/** Composition counts used by the CLI report and the composition tests. */
export function datasetStats(dataset) {
  const alerts = dataset.alerts;
  return {
    total: alerts.length,
    byQueue: countBy(alerts, a => a.expected.queue),
    byDifficulty: countBy(alerts, a => a.difficulty),
    byBlastRadius: countBy(alerts, a => a.expected.blast_radius),
    quarantineTrue: alerts.filter(a => a.expected.quarantine).length,
    crossAlertInjection: alerts.filter(a => a.tags.includes('cross-alert-injection')).map(a => a.id),
    labelledBy: dataset.labelledBy,
  };
}
