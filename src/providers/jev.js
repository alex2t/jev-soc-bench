/** TypeSafe Jev through the OpenRouter Decisions API. */

import { performance } from 'node:perf_hooks';

const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';

export async function callJev({ state, questions, model, apiKey, fetchImpl = fetch, timeoutMs = 45_000 }) {
  const started = performance.now();
  const res = await fetchImpl(DECISIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'jev-soc-bench',
    },
    body: JSON.stringify({ model, state, questions }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw providerError('jev', res.status, performance.now() - started);
  const raw = await res.json();
  const latencyMs = performance.now() - started;
  return { raw, latencyMs, model: raw.model ?? model, usage: normaliseUsage(raw.usage) };
}

export function providerError(provider, status, latencyMs) {
  // Never include upstream bodies or headers: they can echo the request.
  return Object.assign(new Error(`${provider} HTTP ${status}`), { status, latencyMs, kind: 'http_error' });
}

/** Map OpenRouter usage to { inputTokens, outputTokens, costUsd }; unknown values are null. */
export function normaliseUsage(u) {
  if (!u) return null;
  return {
    inputTokens: u.input_tokens ?? u.prompt_tokens ?? null,
    outputTokens: u.output_tokens ?? u.completion_tokens ?? null,
    costUsd: typeof u.cost === 'number' ? u.cost : null,
  };
}
