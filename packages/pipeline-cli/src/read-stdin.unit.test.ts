import {Effect, Exit} from "effect";
import {describe, expect, it} from "vitest";
import {readStdinText, type StdinReadFailed} from "./read-stdin.ts";
import type {StdinIo} from "./read-stdin-core.ts";

const io = (read: StdinIo["read"], isTTY = false): StdinIo => {
	let clock = 0;
	return {
		isTTY,
		read,
		sleep: (ms) => {
			clock += ms;
		},
		now: () => clock,
	};
};

const eagain = (): never => {
	throw Object.assign(new Error("read EAGAIN"), {code: "EAGAIN"});
};

describe("readStdinText", () => {
	it("succeeds with the piped text", () => {
		let reads = 0;
		const source = io((into) => {
			reads += 1;
			if (reads > 1) return 0;
			const bytes = Buffer.from("piped", "utf8");
			bytes.copy(into);
			return bytes.length;
		});
		expect(Effect.runSync(readStdinText(undefined, source))).toBe("piped");
	});

	it("succeeds with '' when nothing was piped in — the no-hang TTY case", () => {
		expect(
			Effect.runSync(
				readStdinText(
					undefined,
					io(() => 0, true),
				),
			),
		).toBe("");
	});

	// The whole point: an unread pipe lands in the error channel, where "" used to be.
	it("fails with StdinReadFailed on a pipe that never drains", () => {
		const exit = Effect.runSyncExit(readStdinText({pollMs: 1, idleTimeoutMs: 10}, io(eagain)));
		expect(Exit.isFailure(exit)).toBe(true);
		const error = Exit.isFailure(exit) ? exit.cause : undefined;
		expect(JSON.stringify(error)).toContain("StdinReadFailed");
	});

	it("carries a reason that names the errno, so the failure is diagnosable", () => {
		const exit = Effect.runSyncExit(
			readStdinText({pollMs: 1, idleTimeoutMs: 10}, io(eagain)).pipe(
				Effect.catchTag("StdinReadFailed", (error: StdinReadFailed) =>
					Effect.succeed(error.reason),
				),
			),
		);
		expect(Exit.isSuccess(exit) && exit.value).toContain("EAGAIN");
	});
});
