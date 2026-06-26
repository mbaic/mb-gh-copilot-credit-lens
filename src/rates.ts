// Model credit-rate table used only for *estimation* when a usage record has
// no exact billing field. These are GitHub Copilot "premium request"
// multipliers: a single request to a model costs (multiplier) AI credits.
//
// IMPORTANT: these multipliers are published by GitHub and change over time.
// They are intentionally isolated in this one file so updating them is a
// one-line edit with no ripple. Estimated figures are always labelled as such
// in the UI and never silently merged into exact totals unless the user opts in.

// Matched by longest known prefix against the lowercased model id, so version
// suffixes (e.g. "claude-sonnet-4.6", "gpt-4o-mini-2024-07-18") need no entry.
/** Premium-request multipliers keyed by a normalized model family prefix.
 *  Since 2026-06-01 GitHub bills by token consumption (1 AI Credit = $0.01);
 *  these per-request estimates are calibrated from the legacy multipliers and
 *  used only when exact copilotUsageNanoAiu is absent from the log. */
const MODEL_MULTIPLIERS: Record<string, number> = {
  // GPT-4 family — cheap tier under token billing
  'gpt-4o-mini': 0.1,
  'gpt-4o': 0.25,
  'gpt-4.1-mini': 0.1,
  'gpt-4.1': 0.25,
  // GPT-5 mini variants (0.33x legacy)
  'gpt-5-mini': 0.33,
  'gpt-5.4-mini': 0.33,
  'gpt-5.5-mini': 0.33,
  // GPT-5 full variants (1x legacy)
  'gpt-5.3-codex': 1,
  'gpt-5.4': 1,
  'gpt-5.5': 1,
  'gpt-5': 1,
  // Reasoning models (1x legacy)
  'o3-mini': 1,
  'o3': 1,
  'o4-mini': 1,
  // Claude family
  'claude-haiku': 0.33,
  'claude-sonnet': 1,
  'claude-opus-4.6': 10,
  'claude-opus-4-6': 10,
  'claude-opus': 15,
  // Google Gemini
  'gemini-3.1-pro': 0.5,
  'gemini': 0.25
};

/** Fallback multiplier for models not present in the table. */
const DEFAULT_MULTIPLIER = 1;

/**
 * Map a raw model id (e.g. "claude-sonnet-4-5", "gpt-4o-2024-08-06") onto a
 * table key by matching the longest known prefix family. This tolerates the
 * version suffixes that vendors append without needing a table entry per build.
 */
export function normalizeModel(rawModel: string): string {
  const model = (rawModel || '').toLowerCase().trim();
  if (!model) {
    return 'unknown';
  }
  let best = '';
  for (const key of Object.keys(MODEL_MULTIPLIERS)) {
    if (model.startsWith(key) && key.length > best.length) {
      best = key;
    }
  }
  return best || model;
}

/** Estimated credits for one request to the given model. */
export function estimateCredits(rawModel: string): number {
  const key = normalizeModel(rawModel);
  const multiplier = MODEL_MULTIPLIERS[key];
  return multiplier === undefined ? DEFAULT_MULTIPLIER : multiplier;
}

/** True when the model maps to a known family in the rate table. Unknown models
 *  still work (exact credits never depend on this table); they just fall back to
 *  the default multiplier for *estimation*, and the dashboard flags them so the
 *  table can be updated when GitHub introduces a new model. */
export function isKnownModel(rawModel: string): boolean {
  return MODEL_MULTIPLIERS[normalizeModel(rawModel)] !== undefined;
}
