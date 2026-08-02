import {describe, expect, it} from "vitest";
import {readStdinWith, type StdinIo} from "./stdin.ts";

const errno = (code: string): Error => Object.assign(new Error(code), {code});

/** A scripted fd 0: each entry is either bytes to hand back or an errno to throw. */
const io = (
	script: ReadonlyArray<string | Uint8Array | Error>,
	overrides: Partial<StdinIo> = {},
): StdinIo & {clock: {now: number}} => {
	const encoder = new TextEncoder();
	const queue = [...script];
	const clock = {now: 0};
	return {
		clock,
		isTTY: false,
		read: (into) => {
			const next = queue.shift();
			if (next === undefined) return 0;
			if (next instanceof Error) throw next;
			const bytes = typeof next === "string" ? encoder.encode(next) : next;
			into.set(bytes, 0);
			return bytes.length;
		},
		sleep: (ms) => {
			clock.now += ms;
		},
		now: () => clock.now,
		...overrides,
	};
};

describe("readStdinWith", () => {
	it("reads a pipe to EOF", () => {
		expect(readStdinWith(io(["hello "]))).toEqual({_tag: "Text", text: "hello "});
	});

	it('returns Text("") for a pipe that genuinely carried nothing', () => {
		expect(readStdinWith(io([]))).toEqual({_tag: "Text", text: ""});
	});

	it("retries EAGAIN instead of swallowing it to empty (#3924)", () => {
		const read = readStdinWith(io([errno("EAGAIN"), errno("EAGAIN"), "late bytes"]));
		expect(read).toEqual({_tag: "Text", text: "late bytes"});
	});

	it('gives up LOUDLY on a stalled pipe — Failed, never Text("")', () => {
		const read = readStdinWith(io([errno("EAGAIN"), errno("EAGAIN")]), {
			idleTimeoutMs: 10,
			pollMs: 20,
		});
		expect(read._tag).toBe("Failed");
		expect(read._tag === "Failed" && read.reason).toContain("EAGAIN");
	});

	it("returns before the first read on a TTY, so an interactive run never hangs", () => {
		const read = readStdinWith(io(["never reached"], {isTTY: true}));
		expect(read).toEqual({_tag: "NoStdin", reason: "fd 0 is a TTY — nothing was piped in"});
	});

	it("separates an unattached descriptor from a failed read", () => {
		expect(readStdinWith(io([errno("EBADF")]))._tag).toBe("NoStdin");
		expect(readStdinWith(io([errno("EIO")]))._tag).toBe("Failed");
	});

	it("decodes once over the joined bytes, so a split multi-byte character survives", () => {
		const bytes = new TextEncoder().encode("sözlük");
		// `ö` is two bytes at offset 1; splitting between them is what per-chunk decoding mangles.
		const read = readStdinWith(io([bytes.subarray(0, 2), bytes.subarray(2)]));
		expect(read).toEqual({_tag: "Text", text: "sözlük"});
	});
});
