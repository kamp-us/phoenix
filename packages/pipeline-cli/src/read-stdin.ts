/**
 * The shared stdin read every pipeline-cli tool uses — the Effect seam over
 * `read-stdin-core.ts` (#3924).
 *
 * One rule: a failed read of a present pipe never arrives as `""`. It lands in the error
 * channel (`readStdinText`) or, for the tools that just want the fail-closed default, on stderr
 * with a non-zero exit (`readStdinTextOrExit`). `""` still means an empty pipe, and a TTY with
 * nothing piped still returns immediately rather than hanging.
 *
 * fd 0 stays a raw `node:fs` boundary here by design: the Effect `FileSystem` seam is path-keyed
 * with no stdin reader, and `Stdio.stdin` is the blocking Stream that hangs on a TTY
 * (`.patterns/effect-platform-access.md`).
 */
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {
	nodeStdinIo,
	readStdinWith,
	type StdinIo,
	type StdinReadOptions,
} from "./read-stdin-core.ts";

/** The read could not complete — the outcome that used to be indistinguishable from empty stdin. */
export class StdinReadFailed extends Schema.TaggedErrorClass<StdinReadFailed>()("StdinReadFailed", {
	reason: Schema.String,
}) {}

/** Non-zero, and distinct from a gate's own verdict codes: the input was never read. */
export const STDIN_READ_FAILED_EXIT_CODE = 4;

/**
 * All of stdin as UTF-8. Fails with `StdinReadFailed` on an unread pipe; succeeds with `""` when
 * nothing was piped in at all (a TTY or an unattached fd 0).
 */
export const readStdinText = (
	options?: StdinReadOptions,
	io: StdinIo = nodeStdinIo(),
): Effect.Effect<string, StdinReadFailed> =>
	Effect.suspend(() => {
		const outcome = readStdinWith(io, options);
		switch (outcome._tag) {
			case "Text":
				return Effect.succeed(outcome.text);
			case "NoStdin":
				return Effect.succeed("");
			case "Failed":
				return Effect.fail(new StdinReadFailed({reason: outcome.reason}));
		}
	});

/**
 * `readStdinText`, with the fail-closed default already applied: report the failed read on stderr
 * and exit non-zero. This is what a tool adopts when its answer is a function of the piped
 * payload — deciding over evidence it could not read is the defect (#3924, ADR 0092).
 */
export const readStdinTextOrExit = (options?: StdinReadOptions): Effect.Effect<string> =>
	readStdinText(options).pipe(
		Effect.catchTag("StdinReadFailed", (error) =>
			Effect.sync(() => {
				process.stderr.write(`${error.reason}\n`);
				process.exit(STDIN_READ_FAILED_EXIT_CODE);
			}).pipe(Effect.andThen(Effect.never)),
		),
	);
