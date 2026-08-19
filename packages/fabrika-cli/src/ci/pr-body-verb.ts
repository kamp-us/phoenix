/**
 * `ci pr-body` — repair the standing Release PR body a commit subject's literal HTML tag poisons.
 *
 * Runs in `release-please.yml` before release-please reads its own PR back (#5946). The output
 * contract is empty-means-no-work: the repaired body lands on stdout **only when a stray tag had
 * to be neutralized**, so the caller writes back exactly when there is something to write.
 *
 * A completed read exits 0 whether it repaired anything or not — this is a repair, not a gate, and
 * the release run it protects must not go red because the body was already clean. An unreadable
 * pipe is a different answer from an empty one and never collapses into it (#3924).
 */

import {Effect} from "effect";
import type {StdinRead} from "../io/stdin.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {EMPTY_STDIN, PRECONDITION_UNKNOWN} from "./codes.ts";
import {sanitizeReleaseBody} from "./pr-body.ts";

const VERB = "ci pr-body";

export interface PrBodyOptions {
	/** The fd-0 read, injected so a test drives the TTY and unreadable-pipe paths. */
	readonly stdin: () => StdinRead;
}

export const runPrBody = (options: PrBodyOptions): Effect.Effect<VerbOutcome> =>
	Effect.sync(() => {
		const read = options.stdin();
		if (read._tag === "Failed") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: ${read.reason} — the body is UNKNOWN, so no repair is proposed.`,
			);
		}
		if (read._tag === "NoStdin") {
			return refuse(
				EMPTY_STDIN,
				`${VERB}: ${read.reason}. Pipe the Release PR body in: gh api repos/o/r/pulls/N --jq .body | fabrika ci pr-body`,
			);
		}
		if (read.text === "") {
			return refuse(EMPTY_STDIN, `${VERB}: the piped body is empty — there is nothing to repair.`);
		}
		const {body, stripped} = sanitizeReleaseBody(read.text);
		if (stripped.length === 0) {
			return answer("", [`${VERB}: no stray HTML tag in the body — nothing to write.`]);
		}
		return answer(body, [
			`${VERB}: neutralized ${stripped.length} stray HTML tag(s): ${stripped.join(" ")}`,
		]);
	});
