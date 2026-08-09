/**
 * The spend ledger's two halves, driven against a temp directory with no model call (#5009).
 *
 * The append tier runs on the real Node filesystem on purpose: append-only-ness is a property of the
 * open flag, and a scripted `FileSystem` double would assert the call rather than the behaviour.
 */
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeServices} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {
	appendSpendLedger,
	DEFAULT_SPEND_LEDGER_PATH,
	encodeSpendRows,
	LEDGER_ROW_VERSION,
	type LedgerRow,
	persistSpendRows,
	readSpendLedger,
} from "./ledger.ts";
import type {RunSpend} from "./token-spend.ts";

const live = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>): Promise<A> =>
	Effect.runPromise(Effect.provide(effect, NodeServices.layer));

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

const withTempDir = async (body: (dir: string) => Promise<void>): Promise<void> => {
	const dir = mkdtempSync(join(tmpdir(), "fabrika-spend-ledger-"));
	try {
		await body(dir);
	} finally {
		rmSync(dir, {recursive: true, force: true});
	}
};

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

	it("skips a row written by a version it does not know, and counts it", () => {
		const line = JSON.stringify({...JSON.parse(encodeSpendRows([row()]).trim()), v: 99});
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

describe("appendSpendLedger — append-only against a real temp directory", () => {
	it("creates the ledger and its parent directory on the first suite", async () => {
		await withTempDir(async (dir) => {
			const path = join(dir, "nested", "spend-ledger.jsonl");
			await live(appendSpendLedger(path, [row({caseId: 1})]));
			assert.strictEqual(readSpendLedger(readFileSync(path, "utf8")).rows.length, 1);
		});
	});

	it("leaves the first suite's bytes unchanged when a second suite appends", async () => {
		await withTempDir(async (dir) => {
			const path = join(dir, "spend-ledger.jsonl");
			await live(appendSpendLedger(path, [row({caseId: 1})]));
			const first = readFileSync(path, "utf8");
			await live(appendSpendLedger(path, [row({caseId: 2}), row({caseId: 3})]));
			const second = readFileSync(path, "utf8");
			assert.strictEqual(second.slice(0, first.length), first);
			assert.deepStrictEqual(
				readSpendLedger(second).rows.map((r) => r.caseId),
				[1, 2, 3],
			);
		});
	});

	it("appends after a malformed line without rewriting it — the reader skips, the writer does not repair", async () => {
		await withTempDir(async (dir) => {
			const path = join(dir, "spend-ledger.jsonl");
			writeFileSync(path, "half a row, no newline");
			await live(appendSpendLedger(path, [row({caseId: 7})]));
			const read = readSpendLedger(readFileSync(path, "utf8"));
			assert.deepStrictEqual(
				read.rows.map((r) => r.caseId),
				[7],
			);
			assert.strictEqual(read.skipped, 1);
		});
	});

	it("writes nothing at all when the suite produced no rows — not even an empty file", async () => {
		await withTempDir(async (dir) => {
			const path = join(dir, "spend-ledger.jsonl");
			await live(appendSpendLedger(path, []));
			assert.strictEqual(existsSync(path), false);
		});
	});

	it("persists with nothing to say, and says exactly one thing when it could not", async () => {
		await withTempDir(async (dir) => {
			const path = join(dir, "spend-ledger.jsonl");
			assert.deepStrictEqual(await live(persistSpendRows(path, [row()])), []);

			const occupied = join(dir, "occupied");
			writeFileSync(occupied, "");
			const notes = await live(persistSpendRows(join(occupied, "spend-ledger.jsonl"), [row()]));
			assert.strictEqual(notes.length, 1);
			assert.strictEqual(notes[0]?.includes(occupied), true);
		});
	});

	it("fails rather than reporting a write that did not land", async () => {
		await withTempDir(async (dir) => {
			const path = join(dir, "occupied");
			writeFileSync(path, "");
			const outcome = await live(
				Effect.result(appendSpendLedger(join(path, "spend-ledger.jsonl"), [row()])),
			);
			assert.strictEqual(outcome._tag, "Failure");
		});
	});
});
