/** Shared request boundary for the real providers: one timing window, typed errors, no retries. */

import { performance } from 'node:perf_hooks';

// Node's fetch reports a failed connection as "fetch failed" and a connection dropped during
// the body read as "terminated". Other TypeErrors (for example a bad URL) are bugs and propagate.
const NETWORK_FAILURES = ['fetch failed', 'terminated'];

/** Error carrying `kind` (http_error, timeout, schema_error) and `latencyMs`; never upstream data. */
export function providerError(provider, kind, message, latencyMs, status = null) {
  return Object.assign(new Error(`${provider} ${message}`), { kind, latencyMs, status });
}

/**
 * POST a JSON body to OpenRouter and parse the JSON response. Latency covers request sent to
 * body parsed. Throws providerError: http_error on a non-2xx status or a network failure
 * (status null), timeout when timeoutMs passes (during the request or the body read),
 * schema_error when the body is not JSON.
 */
export async function postJson(provider, url, { apiKey, body, fetchImpl, timeoutMs }) {
  const started = performance.now();
  const elapsed = () => performance.now() - started;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'jev-soc-bench',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Never include upstream bodies or headers: they can echo the request.
    if (!res.ok) throw providerError(provider, 'http_error', `HTTP ${res.status}`, elapsed(), res.status);
    const raw = await res.json();
    return { raw, latencyMs: elapsed() };
  } catch (err) {
    if (err.name === 'TimeoutError') throw providerError(provider, 'timeout', `timeout after ${timeoutMs} ms`, elapsed());
    if (err instanceof SyntaxError) throw providerError(provider, 'schema_error', 'response body is not JSON', elapsed());
    if (err instanceof TypeError && NETWORK_FAILURES.includes(err.message)) {
      throw providerError(provider, 'http_error', 'network error', elapsed());
    }
    throw err;
  }
}
