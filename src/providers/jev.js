/** TypeSafe Jev through the OpenRouter Decisions API. */

import { postJson } from './http.js';

const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';

export async function callJev({ state, questions, model, apiKey, fetchImpl = fetch, timeoutMs = 45_000 }) {
  const { raw, latencyMs } = await postJson('jev', DECISIONS_URL, {
    apiKey, fetchImpl, timeoutMs, body: { model, state, questions },
  });
  return { raw, latencyMs, model: raw.model ?? model, usage: normaliseUsage(raw.usage) };
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
