/**
 * The runner, against real child processes. This is the one file in the package that spends a
 * process id: everything else is a record.
 *
 * `/bin/sh` throughout rather than the package's `/bin/zsh` default, because these cases are about
 * the runner and not about which interpreter a config picked, and `sh` is on every machine that
 * could run this suite.
 */

import {describe, expect, it} from "vitest";
import type {Finished, ShellCommand} from "./run.ts";
import {startCommand} from "./run.ts";
import {OUTPUT_BYTE_LIMIT} from "./state.ts";

const base = {
	key: "k1",
	cwd: "/tmp",
	shell: "/bin/sh",
	timeoutMs: null,
} as const;

/** Run one command and wait for the single report it owes. */
const run = (request: Partial<ShellCommand> & {readonly command: string}) =>
	new Promise<Finished>((resolve) => {
		startCommand({...base, ...request}, resolve);
	});

describe("a command that works", () => {
	it("answers exit 0 with what it printed, under the key it was asked with", async () => {
		const finished = await run({command: "printf hi"});
		expect(finished).toMatchObject({
			type: "finished",
			key: "k1",
			code: 0,
			output: "hi",
			timedOut: false,
		});
		expect(finished.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("runs the command *through* the shell, so a pipe is a pipe", async () => {
		const finished = await run({command: "printf 'a\nb\nc\n' | wc -l"});
		expect(finished.code).toBe(0);
		expect(finished.output.trim()).toBe("3");
	});

	it("runs where the config said, and with the environment it was given", async () => {
		const finished = await run({
			command: "pwd; printf '%s\n' \"$TUVAL_SHELL_TEST\"",
			cwd: "/",
			env: {TUVAL_SHELL_TEST: "seen"},
		});
		expect(finished.output).toContain("/\n");
		expect(finished.output).toContain("seen");
	});

	it("keeps the ambient environment rather than replacing it — a child with no PATH runs nothing", async () => {
		const finished = await run({
			command: 'test -n "$PATH" && printf kept',
			env: {TUVAL_SHELL_TEST: "seen"},
		});
		expect(finished.output).toBe("kept");
	});
});

describe("a command that fails", () => {
	it("answers its own exit code and keeps stderr, interleaved with stdout", async () => {
		const finished = await run({
			command: "printf out; printf err 1>&2; exit 3",
		});
		expect(finished.code).toBe(3);
		expect(finished.timedOut).toBe(false);
		expect(finished.output).toContain("out");
		expect(finished.output).toContain("err");
	});

	it("answers a run that never started at all, with the reason as its whole output", async () => {
		const finished = await run({
			command: "printf hi",
			cwd: "/no/such/directory/anywhere",
		});
		expect(finished.code).toBeNull();
		expect(finished.timedOut).toBe(false);
		expect(finished.output).not.toBe("");
	});
});

describe("a command that runs too long", () => {
	it("kills it and says the timeout is what ended it", async () => {
		const finished = await run({command: "sleep 30", timeoutMs: 150});
		expect(finished.timedOut).toBe(true);
		expect(finished.code).toBeNull();
		expect(finished.durationMs).toBeLessThan(5_000);
	});

	/**
	 * The case `detached: true` exists for. `sleep 30 | cat` is two processes; killing only the shell
	 * leaves `cat` holding the pipe this runner reads, so `close` never fires and the timeout hangs
	 * for as long as the pipeline does. The group kill is what makes this case finish at all.
	 */
	it("kills the whole pipeline and not just the shell that started it", async () => {
		const finished = await run({command: "sleep 30 | cat", timeoutMs: 150});
		expect(finished.timedOut).toBe(true);
		expect(finished.durationMs).toBeLessThan(5_000);
	});

	it("leaves a command that finishes inside its timeout alone", async () => {
		const finished = await run({command: "printf quick", timeoutMs: 5_000});
		expect(finished).toMatchObject({
			code: 0,
			timedOut: false,
			output: "quick",
		});
	});
});

describe("an output bigger than the bound", () => {
	it("keeps the last bytes, says how many it dropped, and stays inside the bound", async () => {
		const finished = await run({
			command: `head -c ${OUTPUT_BYTE_LIMIT * 2} /dev/zero | tr '\\0' 'x'; printf END`,
		});
		expect(finished.code).toBe(0);
		const [note, ...rest] = finished.output.split("\n");
		expect(note).toMatch(/bytes of earlier output dropped/);
		expect(rest.join("\n").endsWith("END")).toBe(true);
		expect(Buffer.byteLength(rest.join("\n"), "utf8")).toBeLessThanOrEqual(OUTPUT_BYTE_LIMIT);
	});
});

describe("abandoning a run", () => {
	it("reports nothing after the caller let go, however the child ends", async () => {
		let reported: Finished | null = null;
		const abandon = startCommand({...base, command: "printf hi"}, (finished) => {
			reported = finished;
		});
		abandon();
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(reported).toBeNull();
	});
});
