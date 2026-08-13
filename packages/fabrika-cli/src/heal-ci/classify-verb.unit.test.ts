import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import type {StdinRead} from "../io/stdin.ts";
import {runClassify} from "./classify-verb.ts";
import {EMPTY_STDIN} from "./codes.ts";
import {renderFrame} from "./frames.ts";

const run = (read: StdinRead, json = false) =>
	Effect.runPromise(runClassify({json, stdin: Effect.succeed(read)}));

const text = (value: string): StdinRead => ({_tag: "Text", text: value});

describe("runClassify", () => {
	it("emits one class line per framed context, in the order received", async () => {
		const stream = [
			"logs\t2\tabc",
			renderFrame({
				context: "unit tests",
				jobId: "1",
				bytes: 9,
				truncated: false,
				text: "FAIL src/cart.test.ts > adds a line\nAssertionError: expected 3 to be 2",
			}),
			renderFrame({
				context: "deploy check",
				jobId: "2",
				bytes: 9,
				truncated: false,
				text: "Error: connect ETIMEDOUT registry.npmjs.org:443",
			}),
		].join("\n");
		const out = await run(text(stream));
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			[
				"classified\t2",
				"class\tunit tests\tlogic\tassertion-failure\t2",
				"class\tdeploy check\ttransient\tnetwork-transient\t1",
				"",
			].join("\n"),
		);
	});

	it("classifies a bare body under the null context", async () => {
		const out = await run(text("Error: connect ETIMEDOUT registry.npmjs.org:443\n"));
		expect(out.stdout).toBe(
			["classified\t1", "class\t-\ttransient\tnetwork-transient\t1", ""].join("\n"),
		);
	});

	it("answers unclassified at exit 0 with a fixed field count", async () => {
		const out = await run(text("Something went wrong.\n"));
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(["classified\t1", "class\t-\tunclassified\t-\t-", ""].join("\n"));
		expect(out.stderr.at(-1)).toContain('default-deny, never "transient"');
	});

	it("refuses empty stdin on 3 — an empty read is not an unclassified failure", async () => {
		const out = await run(text("   \n"));
		expect(out.code).toBe(EMPTY_STDIN);
		expect(out.stdout).toBe("");
	});

	it("refuses an UNREADABLE pipe on 1, never as empty", async () => {
		const out = await run({_tag: "Failed", reason: "EAGAIN"});
		expect(out.code).toBe(1);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("UNKNOWN, never empty");
	});

	it("mirrors the line grammar one-for-one under --json", async () => {
		const out = await run(text("AssertionError: expected 3 to be 2\n"), true);
		expect(JSON.parse(out.stdout)).toEqual({
			outcome: "classified",
			count: 1,
			contexts: [{context: "-", class: "logic", signature: "assertion-failure", line: 1}],
		});
	});
});
