/**
 * The roll-up core: summing, grouping, the window, and every number it declines to count (#5010).
 */
import {assert, describe, it} from "@effect/vitest";
import type {LedgerRead, LedgerRow} from "./ledger.ts";
import {type ResolvedWindow, resolveBound, rollUp, selectWindow} from "./rollup.ts";
import type {RunSpend} from "./token-spend.ts";

const spendOf = (billed: number, exCacheRead: number, assistantTurns: number): RunSpend => ({
	_tag: "Reconstructed",
	spend: {
		input: exCacheRead,
		cacheCreate: 0,
		cacheRead: billed - exCacheRead,
		output: 0,
		billed,
		exCacheRead,
		assistantTurns,
		model: "claude-opus-5",
	},
});

const row = (overrides: Partial<LedgerRow> = {}): LedgerRow => ({
	skillName: "write-code",
	stage: "build",
	caseId: 1,
	arm: "with-skill",
	model: "claude-opus-5",
	sessionId: "3f9c1d2b-0000-4000-8000-000000000001",
	cliVersion: "2.1.220",
	recordedAt: "2026-08-09T09:00:00.000Z",
	spend: spendOf(100, 40, 3),
	...overrides,
});

const read = (rows: ReadonlyArray<LedgerRow>, malformed = 0, newerVersion = 0): LedgerRead => ({
	rows,
	skipped: malformed + newerVersion,
	skips: {malformed, newerVersion},
});

const UNBOUNDED: ResolvedWindow = {sinceAt: null, untilAt: null, text: {since: null, until: null}};

const window = (since: string | null, until: string | null): ResolvedWindow => ({
	sinceAt: since === null ? null : resolveBound(since, "since"),
	untilAt: until === null ? null : resolveBound(until, "until"),
	text: {since, until},
});

describe("rollUp — the totals", () => {
	it("sums billed, ex-cache-read, assistant turns and the run count", () => {
		const out = rollUp(read([row(), row({spend: spendOf(50, 20, 1)})]), UNBOUNDED);
		assert.deepStrictEqual(out.totals, {
			billed: 150,
			exCacheRead: 60,
			assistantTurns: 4,
			runs: 2,
			measuredRuns: 2,
		});
	});

	it("counts an unmeasured run as a run but adds nothing to the figures", () => {
		const out = rollUp(
			read([
				row(),
				row({spend: {_tag: "TranscriptMissing"}}),
				row({spend: {_tag: "NoBilledTurns"}}),
			]),
			UNBOUNDED,
		);
		assert.strictEqual(out.totals.billed, 100);
		assert.strictEqual(out.totals.runs, 3);
		assert.strictEqual(out.totals.measuredRuns, 1);
	});

	/** The no-gate ruling, asserted rather than noted: the core has no threshold to trip. */
	it("sums an arbitrarily large total without changing anything about the answer's shape", () => {
		const out = rollUp(read([row({spend: spendOf(7_489_969_208, 1, 1)})]), UNBOUNDED);
		assert.strictEqual(out.totals.billed, 7_489_969_208);
		assert.strictEqual(out.totals.runs, 1);
	});
});

describe("rollUp — the three breakdowns", () => {
	const rows = [
		row({recordedAt: "2026-08-08T10:00:00.000Z", skillName: "write-code", stage: "build"}),
		row({
			recordedAt: "2026-08-09T10:00:00.000Z",
			skillName: "review-code",
			stage: "review",
			arm: "no-skill",
			spend: spendOf(50, 20, 1),
		}),
		row({recordedAt: "2026-08-09T20:00:00.000Z", skillName: "write-code", stage: "build"}),
	];

	it("groups by the UTC day of each row's own stamp", () => {
		const out = rollUp(read(rows), UNBOUNDED);
		assert.deepStrictEqual(
			out.byDay.map((b) => [b.day, b.billed, b.runs]),
			[
				["2026-08-08", 100, 1],
				["2026-08-09", 150, 2],
			],
		);
	});

	it("groups by skill", () => {
		const out = rollUp(read(rows), UNBOUNDED);
		assert.deepStrictEqual(
			out.bySkill.map((b) => [b.skill, b.billed, b.runs]),
			[
				["review-code", 50, 1],
				["write-code", 200, 2],
			],
		);
	});

	it("groups by stage AND arm together — the pair is the comparison, not either alone", () => {
		const out = rollUp(read(rows), UNBOUNDED);
		assert.deepStrictEqual(
			out.byStageArm.map((b) => [b.stage, b.arm, b.billed, b.runs]),
			[
				["build", "with-skill", 200, 2],
				["review", "no-skill", 50, 1],
			],
		);
	});

	it("keeps every breakdown's run count summing back to the total", () => {
		const out = rollUp(read(rows), UNBOUNDED);
		for (const buckets of [out.byDay, out.bySkill, out.byStageArm]) {
			assert.strictEqual(
				buckets.reduce((n, b) => n + b.runs, 0),
				out.totals.runs,
			);
		}
	});
});

describe("resolveBound — what an operator's --since/--until means", () => {
	it("widens a bare date to the whole UTC day, each edge to its own end", () => {
		assert.strictEqual(resolveBound("2026-08-09", "since"), Date.parse("2026-08-09T00:00:00.000Z"));
		assert.strictEqual(resolveBound("2026-08-09", "until"), Date.parse("2026-08-09T23:59:59.999Z"));
	});

	it("takes a full instant as written", () => {
		assert.strictEqual(
			resolveBound("2026-08-09T12:30:00.000Z", "since"),
			Date.parse("2026-08-09T12:30:00.000Z"),
		);
	});

	it("answers null for something that is not a time at all", () => {
		assert.strictEqual(resolveBound("yesterday", "since"), null);
		assert.strictEqual(resolveBound("", "until"), null);
	});
});

describe("selectWindow — the bounds are inclusive at both edges", () => {
	const rows = [
		row({recordedAt: "2026-08-07T23:59:59.999Z", caseId: 1}),
		row({recordedAt: "2026-08-08T00:00:00.000Z", caseId: 2}),
		row({recordedAt: "2026-08-09T23:59:59.999Z", caseId: 3}),
		row({recordedAt: "2026-08-10T00:00:00.000Z", caseId: 4}),
	];

	it("keeps a row on the first millisecond of --since and the last of --until", () => {
		const out = selectWindow(rows, window("2026-08-08", "2026-08-09"));
		assert.deepStrictEqual(
			out.rows.map((r) => r.caseId),
			[2, 3],
		);
	});

	it("leaves an unbounded edge unbounded", () => {
		assert.strictEqual(selectWindow(rows, window("2026-08-09", null)).rows.length, 2);
		assert.strictEqual(selectWindow(rows, window(null, "2026-08-08")).rows.length, 2);
	});

	it("selects zero rows for a window that covers none of them, without failing", () => {
		const out = rollUp(read(rows), window("2027-01-01", "2027-01-02"));
		assert.strictEqual(out.totals.runs, 0);
		assert.deepStrictEqual(out.byDay, []);
		assert.deepStrictEqual(out.bySkill, []);
		assert.deepStrictEqual(out.byStageArm, []);
	});

	it("drops a row a bounded window cannot place in time, and says how many", () => {
		const out = rollUp(
			read([...rows, row({recordedAt: "not a time", caseId: 9})]),
			window("2026-08-08", "2026-08-09"),
		);
		assert.strictEqual(out.totals.runs, 2);
		assert.strictEqual(out.undatedRows, 1);
	});

	it("keeps an undated row in when nothing was bounded — there is nothing to prove", () => {
		const out = rollUp(read([row({recordedAt: "not a time"})]), UNBOUNDED);
		assert.strictEqual(out.totals.runs, 1);
		assert.strictEqual(out.undatedRows, 0);
	});
});

describe("rollUp — the lines it could not read ride out on the answer", () => {
	it("carries the skipped total and both halves onto the rollup", () => {
		const out = rollUp(read([row()], 40, 2), UNBOUNDED);
		assert.deepStrictEqual(out.skipped, {total: 42, malformed: 40, newerVersion: 2});
	});

	it("reports the skipped lines even when the window itself selected nothing", () => {
		const out = rollUp(read([row()], 40, 0), window("2027-01-01", null));
		assert.strictEqual(out.totals.runs, 0);
		assert.strictEqual(out.skipped.total, 40);
	});

	it("echoes the window it covered, so an answer states its own scope", () => {
		const out = rollUp(read([row()]), window("2026-08-01", null));
		assert.deepStrictEqual(out.window, {since: "2026-08-01", until: null});
	});
});
