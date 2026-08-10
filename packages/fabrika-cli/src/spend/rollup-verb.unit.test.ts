import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFs, fakeFs} from "../fakes.test-support.ts";
import {encodeSpendRows, type LedgerRow} from "./ledger.ts";
import {
	LEDGER_ABSENT,
	LEDGER_HOLDS_NO_ROWS,
	LEDGER_UNREADABLE,
	runRollup,
	WINDOW_SELECTED_NO_ROWS,
} from "./rollup-verb.ts";
import type {RunSpend} from "./token-spend.ts";

const PATH = "/repo/.fabrika/spend-ledger.jsonl";

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

interface RunOptions {
	readonly since?: string;
	readonly until?: string;
	readonly json?: boolean;
}

const run = (fs: FakeFs, options: RunOptions = {}) =>
	Effect.runPromise(
		Effect.provide(
			runRollup({
				ledger: PATH,
				since: options.since ?? null,
				until: options.until ?? null,
				json: options.json ?? false,
			}),
			fs.layer,
		),
	);

const withText = (text: string | null) => fakeFs({files: {[PATH]: text}});

const withRows = (rows: ReadonlyArray<LedgerRow>) => withText(encodeSpendRows(rows));

/** The line grammar as a lookup: first field → the rest. */
const fields = (stdout: string): Map<string, ReadonlyArray<string>> =>
	new Map(
		stdout
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => {
				const [kind = "", ...rest] = line.split("\t");
				return [kind, rest] as const;
			}),
	);

describe("spend rollup — the answer", () => {
	it("answers the window's totals with no transcript path supplied by the operator", async () => {
		const out = await run(withRows([row(), row({spend: spendOf(50, 20, 1)})]));

		expect(out.code).toBe(0);
		expect(fields(out.stdout).get("billed")).toEqual(["150"]);
		expect(fields(out.stdout).get("exCacheRead")).toEqual(["60"]);
		expect(fields(out.stdout).get("assistantTurns")).toEqual(["4"]);
		expect(fields(out.stdout).get("runs")).toEqual(["2"]);
	});

	it("emits a day, a skill and a stage-arm breakdown in the one answer", async () => {
		const out = await run(
			withRows([
				row({recordedAt: "2026-08-08T10:00:00.000Z"}),
				row({recordedAt: "2026-08-09T10:00:00.000Z", skillName: "review-code", stage: "review"}),
			]),
		);
		const lines = out.stdout.split("\n");

		expect(lines.filter((l) => l.startsWith("day\t"))).toHaveLength(2);
		expect(lines.filter((l) => l.startsWith("skill\t"))).toHaveLength(2);
		expect(lines.filter((l) => l.startsWith("stage-arm\t"))).toHaveLength(2);
		expect(lines).toContain("day\t2026-08-08\t100\t40\t3\t1\t1");
		expect(lines).toContain("stage-arm\treview\twith-skill\t100\t40\t3\t1\t1");
	});

	it("emits the same answer as JSON under --json", async () => {
		const rows = [row(), row({skillName: "review-code"})];
		const out = await run(withRows(rows), {json: true});
		const parsed = JSON.parse(out.stdout);

		expect(out.code).toBe(0);
		expect(parsed.totals).toEqual({
			billed: 200,
			exCacheRead: 80,
			assistantTurns: 6,
			runs: 2,
			measuredRuns: 2,
		});
		expect(parsed.bySkill.map((b: {skill: string}) => b.skill)).toEqual([
			"review-code",
			"write-code",
		]);
	});

	it("bounds the window with --since and --until, inclusive at both edges", async () => {
		const rows = [
			row({recordedAt: "2026-08-07T12:00:00.000Z"}),
			row({recordedAt: "2026-08-08T00:00:00.000Z"}),
			row({recordedAt: "2026-08-09T23:59:59.999Z"}),
			row({recordedAt: "2026-08-10T00:00:00.000Z"}),
		];
		const out = await run(withRows(rows), {since: "2026-08-08", until: "2026-08-09"});

		expect(out.code).toBe(0);
		expect(fields(out.stdout).get("runs")).toEqual(["2"]);
	});

	it("prints the ledger path and the window on stderr, never on stdout", async () => {
		const out = await run(withRows([row()]), {since: "2026-08-01"});

		expect(out.stderr.join("\n")).toContain(PATH);
		expect(out.stderr.join("\n")).toContain("2026-08-01");
		expect(out.stdout).not.toContain(PATH);
	});

	/** The no-gate ruling, asserted rather than noted: it fails the moment a threshold appears. */
	it("exits 0 on an arbitrarily large total — no exit code varies with a spend magnitude", async () => {
		const out = await run(withRows([row({spend: spendOf(7_489_969_208, 1, 1)})]));

		expect(out.code).toBe(0);
		expect(fields(out.stdout).get("billed")).toEqual(["7489969208"]);
	});

	it("reads persisted rows only — the ledger is the single file it touches, and it writes nothing", async () => {
		const fs = withRows([row()]);
		const out = await run(fs);

		// Any transcript re-parse or side write would need a file this layer does not hold, and the
		// read of it would fail rather than resolve — so a clean answer here is the assertion.
		expect(out.code).toBe(0);
		expect(fs.written.size).toBe(0);
	});
});

describe("spend rollup — it never presents a partial read as a whole total", () => {
	it("puts the skipped-line count on stdout beside the total it qualifies", async () => {
		const good = encodeSpendRows([row()]);
		const out = await run(withText(`${good}not json at all\nalso not json\n`));

		expect(out.code).toBe(0);
		expect(fields(out.stdout).get("skipped")).toEqual(["2"]);
		expect(fields(out.stdout).get("skippedMalformed")).toEqual(["2"]);
		expect(fields(out.stdout).get("skippedNewerVersion")).toEqual(["0"]);
	});

	it("splits damage from a newer row version — one is data loss, the other is upgrade the CLI", async () => {
		const newer = JSON.stringify({...JSON.parse(encodeSpendRows([row()]).trim()), v: 99});
		const out = await run(withText(`${encodeSpendRows([row()])}${newer}\nhalf a row`));

		expect(fields(out.stdout).get("skippedMalformed")).toEqual(["1"]);
		expect(fields(out.stdout).get("skippedNewerVersion")).toEqual(["1"]);
		expect(out.stderr.join("\n")).toContain("upgrade fabrika-cli");
	});

	it("carries the skipped counts into --json too", async () => {
		const out = await run(withText(`${encodeSpendRows([row()])}half a row`), {json: true});

		expect(JSON.parse(out.stdout).skipped).toEqual({total: 1, malformed: 1, newerVersion: 0});
	});

	it("says so on stderr when there was nothing it could not read", async () => {
		const out = await run(withRows([row()]));

		expect(out.stderr.join("\n")).toContain("every line in the ledger was read");
	});

	it("names the rows a bounded window could not place in time", async () => {
		const out = await run(withRows([row(), row({recordedAt: "not a time"})]), {
			since: "2026-08-01",
		});

		expect(fields(out.stdout).get("undatedRows")).toEqual(["1"]);
		expect(out.stderr.join("\n")).toContain("no readable timestamp");
	});
});

describe("spend rollup — the refusals", () => {
	it("refuses a ledger that is provably not there, with empty stdout", async () => {
		const out = await run(fakeFs({files: {}}));

		expect(out.code).toBe(LEDGER_ABSENT);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("nothing has been recorded yet");
	});

	it("refuses an unreadable ledger as UNKNOWN, never as absent and never as a zero", async () => {
		const out = await run(fakeFs({files: {[PATH]: null}, unprobeable: [PATH]}));

		expect(out.code).toBe(LEDGER_UNREADABLE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("UNKNOWN");
	});

	it("refuses an empty ledger rather than answering a fabricated zero total", async () => {
		const out = await run(withText(""));

		expect(out.code).toBe(LEDGER_HOLDS_NO_ROWS);
		expect(out.stdout).toBe("");
	});

	it("refuses a ledger whose every line is unreadable, and says how many were lost", async () => {
		const out = await run(withText("half a row\nanother half\n"));

		expect(out.code).toBe(LEDGER_HOLDS_NO_ROWS);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("2 ledger line(s) could NOT be read");
	});

	it("refuses a window that selects no rows on its OWN code, distinct from an empty ledger", async () => {
		const out = await run(withRows([row()]), {since: "2027-01-01"});

		expect(out.code).toBe(WINDOW_SELECTED_NO_ROWS);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("an empty window, not an empty ledger");
	});

	it("seats all four outcomes above the reserved codes, distinct from each other", () => {
		const codes = [LEDGER_ABSENT, LEDGER_UNREADABLE, LEDGER_HOLDS_NO_ROWS, WINDOW_SELECTED_NO_ROWS];
		for (const code of codes) expect(code).toBeGreaterThanOrEqual(3);
		expect(new Set(codes).size).toBe(4);
	});

	it("refuses a --since that is not a time as a usage error, not as an empty window", async () => {
		const out = await run(withRows([row()]), {since: "yesterday"});

		expect(out.code).toBe(1);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("is not a time");
	});

	it("refuses under --json too — a refusal never puts a payload on stdout", async () => {
		const out = await run(withText(""), {json: true});

		expect(out.code).toBe(LEDGER_HOLDS_NO_ROWS);
		expect(out.stdout).toBe("");
	});
});
