/**
 * The half of `emit` only a real subprocess can prove: an answer bigger than the pipe buffer arrives
 * whole.
 *
 * Nothing in-process can catch this. The defect was `process.exit` running before the OS pipe had
 * drained, so it needs a real process, a real pipe, and an answer past the buffer — under those
 * three the pre-fix build returned 65,536 of 3,795,600 bytes on exit 0 (#6226). An assertion on the
 * *shape* of stdout passes against that bug; the assertions here are byte-exact.
 *
 * `wire emit` is the producer because its answer scales with stdin, it touches no network, and its
 * composition is a pure function this file can call directly for the expected bytes.
 */
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "./test-budget.ts";
import {emitFromFields} from "./wire/build-deviations.ts";
import {ZERO_SCOPE} from "./wire/codes.ts";

const BIN = fileURLToPath(new URL("./bin.ts", import.meta.url));

/** Comfortably past a 64 KiB pipe buffer — the pre-fix build stopped at one bufferful. */
const ENTRIES = 20_000;

const fields = [
	"issue: 6226",
	...Array.from(
		{length: ENTRIES},
		(_unused, at) => `-\tsaid ${at}\tdid ${at}\twhy ${at}\tstated here ${at}`,
	),
].join("\n");

/**
 * `FABRIKA_SKIP_INFER` pins the invocation to *this* copy: the delegation would otherwise resolve
 * whichever install the enclosing repo root pins, which is not the tree under test.
 */
const fabrika = (
	args: ReadonlyArray<string>,
	input: string,
): {readonly code: number; readonly stdout: string} => {
	try {
		return {
			code: 0,
			stdout: execFileSync(process.execPath, [BIN, ...args], {
				encoding: "utf8",
				env: {...process.env, FABRIKA_SKIP_INFER: "1"},
				input,
				// execFileSync's own default is 1 MiB, and the answer under test is larger.
				maxBuffer: 64 * 1024 * 1024,
				stdio: ["pipe", "pipe", "pipe"],
			}),
		};
	} catch (err) {
		const failure = err as {status?: number; stdout?: string};
		return {code: failure.status ?? -1, stdout: failure.stdout ?? ""};
	}
};

describe("a verb's answer survives a pipe", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it("delivers a multi-megabyte answer byte-complete", () => {
		const composed = emitFromFields(fields);
		expect(composed._tag).toBe("Composed");
		const bytes = composed._tag === "Composed" ? composed.bytes : "";
		const expected = bytes.endsWith("\n") ? bytes : `${bytes}\n`;
		expect(expected.length).toBeGreaterThan(1024 * 1024);

		const run = fabrika(["wire", "emit", "--format", "build-deviations"], fields);

		expect(run.code).toBe(0);
		expect(run.stdout.length).toBe(expected.length);
		expect(run.stdout).toBe(expected);
	});

	it("still returns the verb's own exit code", () => {
		const run = fabrika(["wire", "emit", "--format", "no-such-format"], fields);
		expect(run.code).toBe(ZERO_SCOPE);
		expect(run.stdout).toBe("");
	});
});
