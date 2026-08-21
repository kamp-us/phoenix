/**
 * Write a verb's outcome to the process streams and exit on its code — stdout is the answer,
 * everything else is stderr.
 *
 * **The exit hangs off the write callbacks, not off the write call returning.** When stdout is a
 * pipe — including the `x=$(fabrika …)` a caller writes without thinking of it as one — the write is
 * asynchronous, and `process.exit` tears the process down without draining what is still queued. So
 * exiting on the line after the write discarded every byte past the pipe buffer, silently and on
 * exit 0, exactly when the answer was long enough for a reader to need all of it (#6226).
 *
 * The exit is explicit on every code, 0 included, so the code a verb computed is the code the
 * process returns rather than whatever the runtime would have inferred. `process.exitCode` is set
 * ahead of the writes so a stream that never reports a flush still lands on that same code.
 */
import {Effect} from "effect";
import type {VerbOutcome} from "./verb.ts";

export const emit = (outcome: VerbOutcome): Effect.Effect<never> =>
	Effect.callback<never>(() => {
		process.exitCode = outcome.code;

		// The exit holds a count of its own alongside each stream's, so a callback that fires
		// synchronously cannot exit before the second write has been issued.
		let pending = 1;
		const settle = (): void => {
			pending -= 1;
			if (pending === 0) process.exit(outcome.code);
		};
		const write = (stream: NodeJS.WriteStream, chunk: string): void => {
			if (chunk === "") return;
			pending += 1;
			stream.write(chunk, settle);
		};

		write(process.stderr, outcome.stderr.map((line) => `${line}\n`).join(""));
		write(process.stdout, outcome.stdout);
		settle();
	});
