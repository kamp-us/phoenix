/**
 * The `release-pr-body` tool — `pipeline-cli release-pr-body sanitize`.
 *
 *   gh api repos/o/r/pulls/N --jq .body | pipeline-cli release-pr-body sanitize > repaired.md
 *
 * The repair `release-please.yml` runs over the standing Release PR before release-please reads it
 * back (#5946). Reads the body on stdin; prints the repaired body on stdout **only when a stray
 * HTML-looking tag had to be neutralized**, and nothing at all when the body already parses — so a
 * caller writes back exactly when there is something to write, the same empty-output-means-no-work
 * contract `intake-dedup check` carries. The count and each neutralized tag go to stderr.
 *
 * Exit 0 on any completed read, repaired or not: this is a repair, not a gate — the run it protects
 * must not go red because the body was already clean. An unreadable stdin still exits non-zero
 * through the shared reader rather than posing as an empty body (#3924).
 *
 * The judgment lives in `release-pr-body.ts` (the pure core); this file is the thin CLI over it.
 */
import {Effect} from "effect";
import {Command} from "effect/unstable/cli";
import {readStdinTextOrExit} from "../../read-stdin.ts";
import {sanitizeReleaseBody} from "./release-pr-body.ts";

const sanitize = Command.make(
	"sanitize",
	{},
	Effect.fn(function* () {
		const {body, stripped} = sanitizeReleaseBody(yield* readStdinTextOrExit());
		yield* Effect.sync(() => {
			if (stripped.length === 0) {
				process.stderr.write(
					"release-pr-body: no stray HTML tag in the body — nothing to write.\n",
				);
				return;
			}
			process.stderr.write(
				`release-pr-body: neutralized ${stripped.length} stray HTML tag(s): ${stripped.join(" ")}\n`,
			);
			process.stdout.write(body);
		});
	}),
).pipe(
	Command.withDescription(
		"Neutralize stray HTML tags in a Release PR body so release-please can parse it back (#5946)",
	),
);

export const releasePrBodyCommand = Command.make("release-pr-body").pipe(
	Command.withSubcommands([sanitize]),
	Command.withDescription(
		"Repair the standing Release PR body a commit subject's literal HTML tag poisons (#5946)",
	),
);
