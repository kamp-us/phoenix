/**
 * The wire codes the per-actor mutation throttle (ADR 0177) injects at the fate
 * composition seam — NOT through any feature's declared error union, so
 * `declaredWireCodes(fateConfig)` (which walks declared unions) does not see
 * them. The SPA-coverage guard (`fate/wireCodes.unit.test.ts`) unions this set
 * onto the declared set, so the SPA `FATE_WIRE_CODES` list must still cover it —
 * the single source both the guard and any future throttle code read from.
 */
export const THROTTLE_WIRE_CODES = ["RATE_LIMIT_EXCEEDED"] as const;
