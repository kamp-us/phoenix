/**
 * `laneConcurrencyCap` — how many issue lanes this repo lets a driver hold at once.
 *
 * A seat is a lane somebody is driving: active on its own log AND claimed on its issue, plus every
 * lane no read can account for. See [`concurrency.ts`](../../lane/concurrency.ts) for the counting.
 *
 * "Cap at 2 for the rest of the night" was a spoken instruction, so it bound only the operator who
 * heard it and only for as long as they remembered it. Declared here it binds the boot itself:
 * `lane open` and `lane emit` count the seats before they write, and refuse past the number.
 *
 * Both read it out of the repository that OWNS the cwd rather than the cwd itself
 * ([`configRootOrRefuse`](../../lane/ground.ts)), because the seats are counted in that repository's
 * one shared ledger: a linked worktree's own tracked copy would cap a count it contributed nothing
 * to.
 *
 * **The shipped default is `null` — no cap.** A repo that declares nothing is not capped, matching
 * every other shipped default on this surface, which declines rather than guessing a number that
 * fits somebody else's machine. `null` is also writable, and means the same thing said out loud.
 *
 * A declared value is a **positive integer**: `0` would be a cap no boot could ever clear, and a
 * fraction or a numeric string is a value the writer did not mean. All of them refuse at load rather
 * than round, because a cap silently repaired to a different number is one the operator believes
 * they set and did not.
 */

import type {Decoded, KeyGroup} from "../key-group.ts";

export const LANE_CONCURRENCY_CAP = "laneConcurrencyCap";

/** A repo declaring nothing has no cap — the decline, not a number guessed for it. */
export const SHIPPED_LANE_CONCURRENCY_CAP: number | null = null;

const decode = (raw: unknown): Decoded<number | null> => {
	if (raw === null) return {_tag: "Value", value: null};
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
		return {
			_tag: "Malformed",
			reason: `\`${LANE_CONCURRENCY_CAP}\` is not a positive integer — write the number of issue lanes that may stand open at once, or null for no cap`,
		};
	}
	return {_tag: "Value", value: raw};
};

export const laneConcurrencyCapKey: KeyGroup<number | null> = {
	key: LANE_CONCURRENCY_CAP,
	shippedDefault: SHIPPED_LANE_CONCURRENCY_CAP,
	decode,
	jsonSchema: {
		type: ["integer", "null"],
		description:
			"How many CLAIMED issue lanes may stand open at once — an active lane no driver claims is idle and counts for nothing. `lane open` and `lane emit` refuse past it, with no override. Write null (or leave it out) for no cap.",
		minimum: 1,
	},
};
