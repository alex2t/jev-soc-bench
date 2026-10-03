/** Turn normalised answers into a triage action, identically for every provider. */

const THRESHOLDS = ['minQueueConfidence', 'autoQuarantineAt', 'autoCloseBelow'];

/** Throw if any threshold is missing or outside 0..1, so no comparison silently fails. */
export function checkPolicy(policy) {
  for (const name of THRESHOLDS) {
    const v = policy?.[name];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      throw new Error(`policy.${name} must be a number from 0 to 1, got ${JSON.stringify(v)}`);
    }
  }
}

/**
 * Apply the rules of plan.md section 6 in order. Returns { action, reason, queue }.
 * Rule 1 only applies when the provider returned a queue confidence (Jev, not the LLM).
 */
export function decide(answers, policy) {
  checkPolicy(policy);
  const queue = answers.queue.value;
  const { confidence } = answers.queue;
  const quarantine = answers.quarantine.value;
  if (confidence !== null && confidence < policy.minQueueConfidence) {
    return { action: 'analyst_review', reason: 'low_queue_confidence', queue };
  }
  if (quarantine >= policy.autoQuarantineAt) {
    return { action: 'auto_quarantine', reason: 'quarantine_threshold', queue };
  }
  if (quarantine <= policy.autoCloseBelow && queue === 'benign_noise' && answers.blast_radius.level === 0) {
    return { action: 'auto_close', reason: 'benign_low_risk', queue };
  }
  return { action: 'analyst_review', reason: 'default', queue };
}
