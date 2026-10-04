/**
 * `ci pr-body` repairs the standing Release PR body before release-please reads it.
 * See `ci pr-body --help` for the output and exit behavior.
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
