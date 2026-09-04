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
 * Constant-time compare over the hex text. The guarded quantity is the UTF-8 **byte** length, not
 * the character count: `timingSafeEqual` throws on unequal byte lengths, and the presented token
 * arrives percent-decoded, so one multibyte character is 64 characters and 65 bytes and a
 * character-length guard waves it into the throw. The length is not the secret.
 */
export const tokenMatches = (expected: Redacted.Redacted<string>, presented: string): boolean => {
	const value = Buffer.from(Redacted.value(expected), "utf8");
	const candidate = Buffer.from(presented, "utf8");
	if (candidate.length !== value.length) return false;
	return timingSafeEqual(candidate, value);
};
