/**
 * `triage audit-merge` runs over a scripted filesystem and nothing else: the layer below provides no
 * HTTP seam, so a merge that reached for the issue tracker would not run.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {ANSWER} from "../verb.ts";
import {runAuditMerge} from "./audit-merge-verb.ts";
import {
	CHUNK_MISCOUNTED,
	DUPLICATE_VERDICT,
	MALFORMED_AUDIT,
	PRECONDITION_UNKNOWN,
	SET_MISMATCH,
	ZERO_SCOPE,
} from "./codes.ts";

const INPUT = "/work/set.json";
const A = "/work/a.json";
const B = "/work/b.json";

const set = (...numbers: ReadonlyArray<number>) =>
	JSON.stringify({
		outcome: "set",
		label: "audit-me",
		repo: "o/r",
		issues: numbers.map((number) => ({number, title: `t${number}`})),
		scanned: numbers.length,
	});

const keep = (issue: number) => ({issue, verdict: "KEEP", evidence: "live"});
const kill = (issue: number) => ({
	issue,
	verdict: "KILL",
	clause: "hardening-with-no-incident",
	evidence: "never failed",
});
const chunkDoc = (rows: ReadonlyArray<unknown>, declared = rows.length) =>
	JSON.stringify({declared, rows});

const run = (
	files: Readonly<Record<string, string>>,
	chunks: ReadonlyArray<string> = [A, B],
	json = false,
) =>
	Effect.runPromise(
		Effect.provide(runAuditMerge({input: INPUT, chunks, json}), fakeFs({files}).layer),
	);

describe("runAuditMerge", () => {
	it("prints `merged` then one row per audited issue, ascending", async () => {
		const out = await run({
			[INPUT]: set(1, 2, 3),
			[A]: chunkDoc([keep(3), kill(1)]),
			[B]: chunkDoc([keep(2)]),
		});
		expect(out.code).toBe(ANSWER);
		expect(out.stdout).toBe(
			"merged\n1\tKILL\thardening-with-no-incident\tnever failed\n2\tKEEP\t-\tlive\n3\tKEEP\t-\tlive\n",
		);
		expect(out.stderr.join("\n")).toContain("1 KILL, 0 DECIDE, 2 KEEP");
	});

	it("prints `{outcome, rows, counts}` under --json", async () => {
		const out = await run({[INPUT]: set(1), [A]: chunkDoc([keep(1)])}, [A], true);
		expect(JSON.parse(out.stdout)).toEqual({
			outcome: "merged",
			rows: [keep(1)],
			counts: {KILL: 0, DECIDE: 0, KEEP: 1},
		});
	});

	it("refuses, writing nothing, when a chunk's rows differ from its declared total", async () => {
		const out = await run({
			[INPUT]: set(1, 2, 3),
			[A]: chunkDoc([keep(1)], 2),
			[B]: chunkDoc([keep(3)]),
		});
		expect(out.code).toBe(CHUNK_MISCOUNTED);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain(`${A} declares 2 rows and carries 1`);
	});

	it("refuses, writing nothing, when an issue appears in more than one row", async () => {
		const out = await run({
			[INPUT]: set(1, 2),
			[A]: chunkDoc([keep(1), keep(2)]),
			[B]: chunkDoc([kill(2)]),
		});
		expect(out.code).toBe(DUPLICATE_VERDICT);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain(`#2 is judged in ${A}, ${B}`);
	});

	it("refuses, writing nothing, when the merged set misses an audited issue", async () => {
		const out = await run({
			[INPUT]: set(1, 2, 3),
			[A]: chunkDoc([keep(1)]),
			[B]: chunkDoc([keep(3)]),
		});
		expect(out.code).toBe(SET_MISMATCH);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("missing #2");
	});

	it("refuses, writing nothing, when a row names an issue the audit never listed", async () => {
		const out = await run({
			[INPUT]: set(1),
			[A]: chunkDoc([keep(1)]),
			[B]: chunkDoc([kill(40)]),
		});
		expect(out.code).toBe(SET_MISMATCH);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("not in the input set #40");
	});

	it("refuses a chunk carrying a malformed verdict row on 22", async () => {
		const out = await run(
			{
				[INPUT]: set(1),
				[A]: chunkDoc([{issue: 1, verdict: "KILL", evidence: "no clause"}]),
			},
			[A],
		);
		expect(out.code).toBe(MALFORMED_AUDIT);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("KILL names no value-bar clause");
	});

	it("refuses a file that is not JSON on 22", async () => {
		const out = await run({[INPUT]: set(1), [A]: "| 1 | KEEP |"}, [A]);
		expect(out.code).toBe(MALFORMED_AUDIT);
	});

	it("refuses an unreadable file as UNKNOWN on 11", async () => {
		const out = await run({[INPUT]: set(1)}, [A]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("refuses an empty input set on 7 — a merge over zero scope proves nothing", async () => {
		const out = await run({[INPUT]: set(), [A]: chunkDoc([])}, [A]);
		expect(out.code).toBe(ZERO_SCOPE);
	});
});
