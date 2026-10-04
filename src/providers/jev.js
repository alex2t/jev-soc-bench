/** TypeSafe Jev through the OpenRouter Decisions API. */

import { postJson } from './http.js';

const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';

export async function callJev({ state, questions, model, apiKey, fetchImpl = fetch, timeoutMs = 45_000 }) {
  const { raw, latencyMs } = await postJson('jev', DECISIONS_URL, {
    apiKey, fetchImpl, timeoutMs, body: { model, state, questions },
  });
  return { raw, latencyMs, model: raw.model ?? model, usage: normaliseUsage(raw.usage) };
}

/**
 * Map OpenRouter usage to { inputTokens, cachedInputTokens, outputTokens, reasoningTokens, costUsd };
 * unknown values are null. Output tokens include hidden reasoning tokens, which are billed as
 * output (F-34). Cached input tokens are billed at a lower rate, so cost depends on them (F-43).
 */
export function normaliseUsage(u) {
  if (!u) return null;
  return {
    inputTokens: u.input_tokens ?? u.prompt_tokens ?? null,
    cachedInputTokens: typeof u.prompt_tokens_details?.cached_tokens === 'number' ? u.prompt_tokens_details.cached_tokens : null,
    outputTokens: u.output_tokens ?? u.completion_tokens ?? null,
    reasoningTokens: typeof u.completion_tokens_details?.reasoning_tokens === 'number' ? u.completion_tokens_details.reasoning_tokens : null,
    costUsd: typeof u.cost === 'number' ? u.cost : null,
  };
}
