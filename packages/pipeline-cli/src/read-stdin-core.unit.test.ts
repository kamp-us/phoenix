import {closeSync, mkdtempSync, openSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {nodeStdinIo, readStdinWith, type StdinIo} from "./read-stdin-core.ts";

/** An errno error shaped like the one `fs.readSync` throws on a non-blocking pipe. */
const errno = (code: string): NodeJS.ErrnoException =>
	Object.assign(new Error(`read ${code}`), {code});

/**
 * A scripted fd: each step is either bytes to hand back or an errno to throw. `sleep`/`now` are
 * driven off a virtual clock so the retry budget is exercised without real waiting.
 */
const scriptedIo = (
	steps: ReadonlyArray<string | NodeJS.ErrnoException>,
	overrides: Partial<StdinIo> = {},
): StdinIo & {readonly sleeps: ReadonlyArray<number>; readonly reads: () => number} => {
	const sleeps: Array<number> = [];
	let clock = 0;
	let index = 0;
	return {
		isTTY: false,
		read: (into) => {
			const step = steps[index];
			index += 1;
			if (step === undefined) return 0;
			if (typeof step !== "string") throw step;
			const bytes = Buffer.from(step, "utf8");
			bytes.copy(into);
			return bytes.length;
		},
		sleep: (ms) => {
			sleeps.push(ms);
			clock += ms;
		},
		now: () => clock,
		sleeps,
		reads: () => index,
		...overrides,
	};
};

describe("readStdinWith", () => {
	it("reads a piped payload to EOF across chunks", () => {
		const io = scriptedIo(["hello ", "world"]);
		expect(readStdinWith(io)).toEqual({_tag: "Text", text: "hello world"});
	});

	it("returns an empty Text for a present-but-empty pipe", () => {
		expect(readStdinWith(scriptedIo([]))).toEqual({_tag: "Text", text: ""});
	});

	it("retries EAGAIN to completion instead of reporting empty stdin", () => {
		const io = scriptedIo([errno("EAGAIN"), errno("EAGAIN"), "roster", errno("EAGAIN"), ""]);
		expect(readStdinWith(io, {pollMs: 5, idleTimeoutMs: 1000})).toEqual({
			_tag: "Text",
			text: "roster",
		});
		expect(io.sleeps).toEqual([5, 5, 5]);
	});

	it("retries EINTR and EWOULDBLOCK the same way", () => {
		const io = scriptedIo([errno("EINTR"), errno("EWOULDBLOCK"), "ok"]);
		expect(readStdinWith(io, {idleTimeoutMs: 1000})).toEqual({_tag: "Text", text: "ok"});
	});

	// The bug this file exists for: a pipe that never drains must not resolve to `Text("")`, which
	// a gate would read as a real zero scope (#3924).
	it("fails loud — never empty — when a non-blocking pipe never drains", () => {
		const io = scriptedIo(Array.from({length: 10_000}, () => errno("EAGAIN")));
		const outcome = readStdinWith(io, {pollMs: 10, idleTimeoutMs: 100});
		expect(outcome._tag).toBe("Failed");
		expect(outcome).not.toEqual({_tag: "Text", text: ""});
		if (outcome._tag === "Failed") expect(outcome.reason).toContain("EAGAIN");
	});

	it("fails loud on a partial read that then stalls", () => {
		const io = scriptedIo(["half a rost", ...Array.from({length: 100}, () => errno("EAGAIN"))]);
		const outcome = readStdinWith(io, {pollMs: 10, idleTimeoutMs: 50});
		expect(outcome._tag).toBe("Failed");
		if (outcome._tag === "Failed") expect(outcome.reason).toContain("11 bytes read so far");
	});

	it("resets the stall budget on every byte read, so a slow producer still completes", () => {
		const slow = [
			errno("EAGAIN"),
			errno("EAGAIN"),
			"a",
			errno("EAGAIN"),
			errno("EAGAIN"),
			"b",
			errno("EAGAIN"),
			errno("EAGAIN"),
			"c",
		];
		expect(readStdinWith(scriptedIo(slow), {pollMs: 20, idleTimeoutMs: 50})).toEqual({
			_tag: "Text",
			text: "abc",
		});
	});

	it("fails loud on a non-retryable read error", () => {
		const outcome = readStdinWith(scriptedIo([errno("EIO")]));
		expect(outcome._tag).toBe("Failed");
		if (outcome._tag === "Failed") expect(outcome.reason).toContain("EIO");
	});

	it("reports an unattached fd 0 as NoStdin, not as a failed read", () => {
		const outcome = readStdinWith(scriptedIo([errno("EBADF")]));
		expect(outcome._tag).toBe("NoStdin");
	});

	// The no-hang constraint: a TTY with nothing piped returns before any read is attempted.
	it("returns NoStdin on a TTY without reading", () => {
		const io = scriptedIo(["never read"], {isTTY: true});
		expect(readStdinWith(io)._tag).toBe("NoStdin");
		expect(io.reads()).toBe(0);
	});

	it("decodes a multi-byte character split across two reads", () => {
		const bytes = Buffer.from("çğü", "utf8");
		const io = scriptedIo([]);
		let call = 0;
		const split: StdinIo = {
			...io,
			read: (into) => {
				call += 1;
				if (call === 1) {
					bytes.subarray(0, 3).copy(into);
					return 3;
				}
				if (call === 2) {
					bytes.subarray(3).copy(into);
					return bytes.length - 3;
				}
				return 0;
			},
		};
		expect(readStdinWith(split)).toEqual({_tag: "Text", text: "çğü"});
	});
});

describe("nodeStdinIo", () => {
	const dirs: Array<string> = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
	});

	it("reads a real fd to EOF through the node primitive", () => {
		const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-stdin-"));
		dirs.push(dir);
		const file = join(dir, "payload.txt");
		writeFileSync(file, "usirin\ncansirin\n", "utf8");
		const fd = openSync(file, "r");
		const outcome = readStdinWith(nodeStdinIo(fd, false));
		closeSync(fd);
		expect(outcome).toEqual({_tag: "Text", text: "usirin\ncansirin\n"});
	});
});
