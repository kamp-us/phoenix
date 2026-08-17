/**
 * `adr next` — the next unused ADR id, against a fetched base ref unioned with open ADR pull
 * requests.
 *
 * The residual race is real and this verb does not close it: two authors between the same pair of
 * invocations still collide. `adr mint` is what removes the gap this verb opens between reading an
 * id and writing it; CI's decision-record validation reds a duplicate that still reaches the merge
 * queue. A verb that claimed to close the race would be lying.
 */
import {Effect} from "effect";
import type {Shell} from "../io/git.ts";
import {answer, type VerbOutcome} from "../verb.ts";
import {resolveAllocation} from "./allocation.ts";

export interface NextOptions {
	readonly dir: string;
	readonly base: string;
	readonly repo: string | null;
	readonly json: boolean;
}

export const runNext = (options: NextOptions): Shell<VerbOutcome> =>
	Effect.gen(function* () {
		const {dir, base, repo, json} = options;

		const resolved = yield* resolveAllocation({verb: "adr next", dir, base, repo});
		if (resolved._tag === "Refused") return resolved.outcome;
		const {allocation, baseSha, scope} = resolved.value;

		return answer(
			json
				? JSON.stringify({
						id: allocation.id,
						mergedMax: allocation.mergedMax,
						inFlight: allocation.inFlight,
						baseRef: base,
						baseSha,
					})
				: allocation.id,
			[scope],
		);
	});
