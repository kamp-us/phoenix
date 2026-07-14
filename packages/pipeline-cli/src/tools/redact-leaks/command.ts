/**
 * The `redact-leaks` tool — `pipeline-cli redact-leaks [--body-file <path>]`.
 *
 * Reads a body (stdin, or `--body-file <path>`), redacts every machine-local path leak while
 * preserving evidential shape, and writes the redacted body to STDOUT. Detection is the shared
 * leak-guard matcher (`findCommentLeaks`); this tool only masks (issue #3021). Triage's Step-4
 * verbatim-preserve step pipes an original through this before nesting it in `<details>`, so a
 * leak-containing original cannot re-leak into the enriched issue body.
 *
 * NOT a gate — always exits 0 and emits the (possibly unchanged) body so it composes in a
 * shell pipeline; each redaction is reported on stderr for observability. `process.stdout.write`
 * (not `Console.log`) so a leak-free body is emitted byte-for-byte, no appended newline (#3021 AC5).
 */
import {readFileSync} from "node:fs";
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {findCommentLeaks} from "../leak-guard/leak-guard.ts";
import {redactLeaks} from "./redact-leaks.ts";

const bodyFileFlag = Flag.string("body-file").pipe(
	Flag.optional,
	Flag.withDescription("path to the body to redact (default: read the body from stdin)"),
);

const readBody = (bodyFile: Option.Option<string>): Effect.Effect<string> =>
	Effect.sync(() =>
		Option.match(bodyFile, {
			onNone: () => readFileSync(0, "utf8"),
			onSome: (path) => readFileSync(path, "utf8"),
		}),
	);

export const redactLeaksCommand = Command.make(
	"redact-leaks",
	{bodyFile: bodyFileFlag},
	Effect.fn(function* ({bodyFile}) {
		const body = yield* readBody(bodyFile);
		for (const leak of findCommentLeaks(body)) {
			yield* Console.error(`redact-leaks: redacted ${leak.matched} — ${leak.reason}`);
		}
		yield* Effect.sync(() => process.stdout.write(redactLeaks(body)));
	}),
).pipe(
	Command.withDescription(
		"Redact machine-local path leaks in a body, preserving evidential shape (issue #3021)",
	),
);
