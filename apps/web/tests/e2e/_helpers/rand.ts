import {randomInt} from "node:crypto";

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * Cryptographically-secure drop-in for the old `.toString(36).slice(2, 2 + len)` idiom on a
 * weak RNG: a `len`-char base36 (0-9a-z) suffix, unique per call, sourced from `node:crypto`
 * so a generated e2e identifier can't trip CodeQL's `js/insecure-randomness` where it flows
 * into the sign-up credential sink in `./auth.ts` (#3361, alert #20). Callers keep their
 * `Date.now()` prefixes for human-readable ordering — the weakness CodeQL flags is the RNG,
 * not the timestamp.
 *
 * `randomInt(36)` draws each index uniformly over [0, 36) — no `randomBytes() % 36`, which
 * would bias residues 0–3 (256 = 7·36 + 4) and trip js/biased-cryptographic-random.
 */
export function randomSuffix(len = 6): string {
	let out = "";
	for (let i = 0; i < len; i++) {
		out += BASE36[randomInt(36)];
	}
	return out;
}
