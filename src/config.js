// -----------------------------------------------------------------------------
// Integration configuration.
//
// The configuration is filled in by the user in Gladys, from the `config_schema`
// declared in `gladys-assistant-integration.json`. The SDK fetches it for you
// (`gladys.getConfig()`) and notifies you of every change through
// `gladys.onConfigUpdated()`.
//
// This module only normalizes the received object, so the rest of the code
// never has to deal with `undefined` or stray whitespace around the token.
// -----------------------------------------------------------------------------

export const DEFAULT_CONFIG = {
  telegram_api_token: '',
};

/**
 * Merge the user config with the defaults.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    // The token is pasted by hand: a leading/trailing space must not break it.
    telegram_api_token: String(raw.telegram_api_token ?? '').trim(),
  };
}
