/**
 * The per-launch capability token (founder ruling, 2026-09-02, on #7567). It is Tuval's addition,
 * not Pi's: the 0.84.3 pin ships no server and the spike server had no auth. 32 random bytes as
 * hex, minted per process spawn, held only in handler memory, never in Demlik state, the
 * checkpoint or a log — which is why it leaves this module wrapped in `Redacted`.
 *
 * `node:crypto` directly, not the `Crypto` service: `timingSafeEqual` has no Effect equivalent,
 * and splitting the mint from the compare would put half the secret's handling somewhere else.
 */

import {randomBytes, timingSafeEqual} from "node:crypto";
import {Redacted} from "effect";

export const TOKEN_BYTES = 32;

export const mintCapabilityToken = (): Redacted.Redacted<string> =>
	Redacted.make(randomBytes(TOKEN_BYTES).toString("hex"));

/**
 * Constant-time compare over the hex text. A length mismatch answers `false` before the compare,
 * because `timingSafeEqual` throws on unequal lengths — the length is not the secret.
 */
export const tokenMatches = (expected: Redacted.Redacted<string>, presented: string): boolean => {
	const value = Redacted.value(expected);
	if (presented.length !== value.length) return false;
	return timingSafeEqual(Buffer.from(presented, "utf8"), Buffer.from(value, "utf8"));
};
