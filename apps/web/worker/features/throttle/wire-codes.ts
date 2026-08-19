/**
 * The throttle (ADR 0177) injects these at the fate composition seam, NOT through a
 * feature's declared error union, so `declaredWireCodes(fateConfig)` cannot see them.
 * The SPA-coverage guard unions this set onto the declared one.
 */
export const THROTTLE_WIRE_CODES = ["RATE_LIMIT_EXCEEDED"] as const;
