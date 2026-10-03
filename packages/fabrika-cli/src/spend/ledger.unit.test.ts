/**
 * The legacy spend ledger's line format, read back the way the roll-up reads it: no filesystem and
 * no model call. Nothing writes this format any more; the reader still has to take every line an
 * older run left behind.
 */
import {assert, describe, it} from "@effect/vitest";
import {
	DEFAULT_SPEND_LEDGER_PATH,
	encodeSpendRows,
	LEDGER_ROW_VERSION,
	type LedgerRow,
	readSpendLedger,
} from "./ledger.ts";
import type {RunSpend} from "./token-spend.ts";

const reconstructed: RunSpend = {
	_tag: "Reconstructed",
	spend: {
		input: 11,
		cacheCreate: 22,
		cacheRead: 33,
		output: 44,
		billed: 110,
		exCacheRead: 77,
		assistantTurns: 3,
		model: "claude-opus-5",
	},
};

const row = (overrides: Partial<LedgerRow> = {}): LedgerRow => ({
	skillName: "write-code",
	stage: "build",
	caseId: 1,
	arm: "with-skill",
	model: "claude-opus-5",
	sessionId: "3f9c1d2b-0000-4000-8000-000000000001",
	cliVersion: "2.1.220",
	recordedAt: "2026-08-09T09:00:00.000Z",
	spend: reconstructed,
	...overrides,
});

/**
 * Widened deliberately. `LEDGER_ROW_VERSION` carries a literal type, so testing it through the
 * constant itself is a tautology today and a `TS2367` "no overlap" error after a bump — and a
 * typecheck error tells the bumper nothing about what to do. Widening keeps the below-current guard
 * a runtime comparison, so the bump lands as a red test carrying its instructions.
 */
const CURRENT_VERSION: number = LEDGER_ROW_VERSION;

describe("the default ledger path", () => {
	it("is repo-relative, so no machine-local literal reaches a source file", () => {
		assert.strictEqual(DEFAULT_SPEND_LEDGER_PATH.startsWith("/"), false);
		assert.strictEqual(DEFAULT_SPEND_LEDGER_PATH.startsWith("~"), false);
		assert.strictEqual(DEFAULT_SPEND_LEDGER_PATH.endsWith(".jsonl"), true);
	});
});

describe("encodeSpendRows — one self-describing JSON line per row", () => {
	it("writes one newline-terminated line per row, each stamped with the row version", () => {
		const text = encodeSpendRows([row({caseId: 1}), row({caseId: 2, arm: "without-skill"})]);
		assert.strictEqual(text.endsWith("\n"), true);
		const lines = text.split("\n").filter((line) => line !== "");
		assert.strictEqual(lines.length, 2);
		for (const line of lines) {
			const parsed = JSON.parse(line) as {v: number};
			assert.strictEqual(parsed.v, LEDGER_ROW_VERSION);
		}
	});

	it("carries every attribution field plus the spend, so a line stands on its own", () => {
		const parsed = JSON.parse(encodeSpendRows([row()]).trim()) as Record<string, unknown>;
		assert.deepStrictEqual(parsed, {
			v: LEDGER_ROW_VERSION,
			skillName: "write-code",
			stage: "build",
			caseId: 1,
			arm: "with-skill",
			model: "claude-opus-5",
			sessionId: "3f9c1d2b-0000-4000-8000-000000000001",
			cliVersion: "2.1.220",
			recordedAt: "2026-08-09T09:00:00.000Z",
			spend: reconstructed,
		});
	});

	it("encodes no rows as the empty string, so a suite with nothing to say writes nothing", () => {
		assert.strictEqual(encodeSpendRows([]), "");
	});

	it("never emits an embedded newline, which is what keeps one row on one line", () => {
		const text = encodeSpendRows([row({skillName: "write\ncode"})]);
		assert.strictEqual(text.split("\n").filter((line) => line !== "").length, 1);
	});
});

describe("readSpendLedger — tolerant of anything a partial write can leave behind", () => {
	it("round-trips every row it wrote, skipping nothing", () => {
		const rows = [row({caseId: 1}), row({caseId: 2, spend: {_tag: "TranscriptMissing"}})];
		const read = readSpendLedger(encodeSpendRows(rows));
		assert.deepStrictEqual(read.rows, rows);
		assert.strictEqual(read.skipped, 0);
	});

	it("round-trips all three spend arms, so an unmeasured run stays unmeasured", () => {
		const arms: ReadonlyArray<RunSpend> = [
			reconstructed,
			{_tag: "NoBilledTurns"},
			{_tag: "TranscriptMissing"},
		];
		const read = readSpendLedger(encodeSpendRows(arms.map((spend) => row({spend}))));
		assert.deepStrictEqual(
			read.rows.map((r) => r.spend),
			arms,
		);
	});

	it("skips a malformed line and a truncated tail, and reports how many it skipped", () => {
		const good = encodeSpendRows([row({caseId: 1}), row({caseId: 2})]);
		const truncated = encodeSpendRows([row({caseId: 3})]).slice(0, 40);
		const read = readSpendLedger(`${good}not json at all\n${truncated}`);
		assert.deepStrictEqual(
			read.rows.map((r) => r.caseId),
			[1, 2],
		);
		assert.strictEqual(read.skipped, 2);
	});

	it("skips a line that parses but is not a row, rather than yielding a half-row", () => {
		const read = readSpendLedger(`{"v":1,"skillName":"write-code"}\n`);
		assert.strictEqual(read.rows.length, 0);
		assert.strictEqual(read.skipped, 1);
	});

	it("skips a row whose spend is structurally wrong — a fabricated zero never gets in", () => {
		const line = JSON.stringify({
			...JSON.parse(encodeSpendRows([row()]).trim()),
			spend: {_tag: "Reconstructed", spend: {billed: "lots"}},
		});
		const read = readSpendLedger(`${line}\n`);
		assert.strictEqual(read.rows.length, 0);
		assert.strictEqual(read.skipped, 1);
	});

	it("keeps damage and a newer row version apart — they ask the operator for opposite things", () => {
		const newer = JSON.stringify({...JSON.parse(encodeSpendRows([row()]).trim()), v: 99});
		const read = readSpendLedger(`not json at all\n${newer}\n${encodeSpendRows([row()])}`);
		assert.strictEqual(read.rows.length, 1);
		assert.deepStrictEqual(read.skips, {malformed: 1, newerVersion: 1});
		assert.strictEqual(read.skipped, 2);
	});

	it("stops calling a below-current row damage the moment an older shape can exist (#5116)", () => {
		const older = JSON.stringify({
			...JSON.parse(encodeSpendRows([row()]).trim()),
			v: CURRENT_VERSION - 1,
		});
		const {skips} = readSpendLedger(`${older}\n`);
		assert.strictEqual(skips.newerVersion, 0);
		assert.strictEqual(
			skips.malformed,
			CURRENT_VERSION === 1 ? 1 : 0,
			`LEDGER_ROW_VERSION is ${CURRENT_VERSION}, so a v${CURRENT_VERSION - 1} line is an intact row written by an older shape — and readSpendLedger still counts it under \`malformed\`, which tells the operator their measurements are damaged while dropping real spend out of the roll-up. Decide it in the bumping change: decode the older shape into a LedgerRow, or count it under a skip of its own that rollup.ts and rollup-verb.ts both render. This guard goes green again by itself once either lands.`,
		);
	});

	it("keeps `skipped` the sum of its halves, so a caller that only wants the gap still gets it", () => {
		const newer = JSON.stringify({...JSON.parse(encodeSpendRows([row()]).trim()), v: 7});
		const read = readSpendLedger(`${newer}\n${newer}\nhalf a row`);
		assert.strictEqual(read.skipped, read.skips.malformed + read.skips.newerVersion);
		assert.deepStrictEqual(read.skips, {malformed: 1, newerVersion: 2});
	});

	it("counts blank lines as nothing at all — a trailing newline is not a skip", () => {
		const read = readSpendLedger(`${encodeSpendRows([row()])}\n   \n`);
		assert.strictEqual(read.rows.length, 1);
		assert.strictEqual(read.skipped, 0);
	});

	it("reads an empty ledger as no rows and no skips, never as a failure", () => {
		assert.deepStrictEqual(readSpendLedger(""), {
			rows: [],
			skipped: 0,
			skips: {malformed: 0, newerVersion: 0},
		});
	});
});
