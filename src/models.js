/**
 * Per-model LLM request settings from config/models.json (F-33). Switching the LLM is a change of
 * LLM_MODEL in .env; a model without an entry stops the run instead of guessing parameters.
 */

const CHECKS = {
  temperature: v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 2) || 'must be a number from 0 to 2',
  reasoning_effort: v => (typeof v === 'string' && v.length > 0) || 'must be a non-empty string',
};

/** Throw on the first problem in the settings file: wrong shape, unknown setting or bad value. */
export function checkModels(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('config/models.json must map model IDs to settings');
  }
  for (const [model, settings] of Object.entries(config)) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`${model}: settings must be an object`);
    if (Object.keys(settings).length === 0) throw new Error(`${model}: settings must not be empty`);
    for (const [name, value] of Object.entries(settings)) {
      if (!(name in CHECKS)) throw new Error(`${model}: unknown setting "${name}"`);
      const ok = CHECKS[name](value);
      if (ok !== true) throw new Error(`${model}: ${name} ${ok}`);
    }
  }
}

/** The validated settings for `model`; throws when the model has no entry. */
export function requestSettings(config, model) {
  checkModels(config);
  if (!(model in config)) throw new Error(`no request settings for ${model} in config/models.json`);
  return config[model];
}
