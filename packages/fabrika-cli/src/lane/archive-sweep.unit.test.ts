/** The sweep that walks a lanes root and archives every lane both gates already clear. */
import {Effect, type FileSystem, type Path} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import type {VerbOutcome} from "../verb.ts";
import type {ClosureState} from "./archive-move.ts";
import {runArchiveSweep, type SweepRow} from "./archive-sweep-verb.ts";
import {APPEND_UNKNOWN, LANE_UNREADABLE, MARKER_READBACK} from "./codes.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";
import {DEFAULT_ARCHIVED_LANES_ROOT, DEFAULT_LANES_ROOT} from "./store.ts";

const ROOT = DEFAULT_LANES_ROOT;
const ARCHIVED = DEFAULT_ARCHIVED_LANES_ROOT;
const TEMPLATE = "/repo/templates/coder.workflow.json";

/** An `ISSUE.PASS` from `queued` no machine has a cell for — the log that will never replay. */
const BROKEN = `${JSON.stringify({task: "issue", event: "ISSUE.PASS", at: "2026-08-19T00:00:00.000Z"})}\n`;

/** A log every machine folds, so the lane is one every sweep can still judge. */
const REPLAYING = ["ISSUE.WIP", "ISSUE.DONE"]
	.map((event) => `${JSON.stringify({task: "issue", event, at: "2026-08-19T00:00:00.000Z"})}\n`)
	.join("");

/** A machine `lane emit` generated: its `id` binds no committed template, so no candidate exists. */
const emittedLaneText = (): string => {
	const document = JSON.parse(coderTemplateText());
	document.id = "epic-5817";
	return JSON.stringify(document, null, "\t");
};

const lane = (key: string, log: string, workflow = coderTemplateText()) => ({
	[`${ROOT}/${key}/workflow.json`]: workflow,
	[`${ROOT}/${key}/events.jsonl`]: log,
});

/** 6037 and the unnumbered directory are dead; 7000 replays; 8000's issue is still open. */
const mixedRoot = (extra: Record<string, string | null> = {}) =>
	fakeFs({
		files: {
			[TEMPLATE]: coderTemplateText(),
			...lane("6037", BROKEN),
			...lane("7000", REPLAYING),
			...lane("8000", BROKEN),
			...lane("frozen-deadlock", BROKEN),
			// A scratch directory under the root is not a lane and owes no row.
			[`${ROOT}/notes/README.md`]: "scratch",
			...extra,
		},
		dirs: {[ROOT]: ["6037", "7000", "8000", "frozen-deadlock", "notes"], [ARCHIVED]: []},
		directories: [
			ROOT,
			ARCHIVED,
			`${ROOT}/6037`,
			`${ROOT}/7000`,
			`${ROOT}/8000`,
			`${ROOT}/frozen-deadlock`,
			`${ROOT}/notes`,
		],
	});

/** Closed for every issue but 8000, which is the live one. */
const board = (issue: number): Effect.Effect<ClosureState> =>
	Effect.succeed(
		issue === 8000 ? {_tag: "Open"} : {_tag: "Closed", reason: "completed"},
	) as Effect.Effect<ClosureState>;

const OPTIONS = {
	root: ROOT,
	archivedRoot: ARCHIVED,
	templatePaths: [TEMPLATE],
	closed: board,
};

const run = (
	fs: ReturnType<typeof fakeFs>,
	eff: Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path>,
) => Effect.runPromise(Effect.provide(eff, fs.layer));

const rowsOf = (out: VerbOutcome): ReadonlyArray<SweepRow> => JSON.parse(out.stdout).lanes;

describe("lane archive --sweep", () => {
	it("moves exactly the lanes both gates clear, and leaves every other directory where it was", async () => {
		const fs = mixedRoot();
		const out = await run(fs, runArchiveSweep(OPTIONS));

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "swept",
			root: ROOT,
			present: true,
			examined: 4,
			archived: 1,
		});
		expect(fs.written.get(`${ARCHIVED}/6037/events.jsonl`)).toBe(BROKEN);
		for (const key of ["7000", "8000", "frozen-deadlock"]) {
			expect(fs.written.has(`${ARCHIVED}/${key}/events.jsonl`)).toBe(false);
		}
	});

	it("prints one row per lane examined, naming the reason it skipped each", async () => {
		const fs = mixedRoot();
		const out = await run(fs, runArchiveSweep(OPTIONS));

		expect(rowsOf(out)).toMatchObject([
			{key: "6037", outcome: "archived", issue: 6037, to: `${ARCHIVED}/6037`},
			{key: "7000", outcome: "skipped", reason: "replays"},
			{key: "8000", outcome: "skipped", reason: "issue-open"},
			{key: "frozen-deadlock", outcome: "skipped", reason: "no-issue"},
		]);
		const stderr = out.stderr.join("\n");
		expect(stderr).toContain("4 lane(s) examined, 1 archived");
		for (const key of ["6037", "7000", "8000", "frozen-deadlock"]) {
			expect(stderr).toContain(`${key}:`);
		}
	});

	// The quarantine convention puts `<issue>.<suffix>` directories in the root, and one name the
	// verb cannot resolve must not cost every other lane its sweep.
	it("skips an unresolvable key without aborting and without moving it", async () => {
		const fs = mixedRoot();
		const out = await run(fs, runArchiveSweep(OPTIONS));
		const row = rowsOf(out).find((entry) => entry.key === "frozen-deadlock");

		expect(row).toMatchObject({outcome: "skipped", reason: "no-issue"});
		expect(fs.written.has(`${ARCHIVED}/frozen-deadlock/workflow.json`)).toBe(false);
	});

	it("archives a lane whose key carries a quarantine suffix, reading the issue it still names", async () => {
		const fs = fakeFs({
			files: {[TEMPLATE]: coderTemplateText(), ...lane("8012.frozen-deadlock-20260905", BROKEN)},
			dirs: {[ROOT]: ["8012.frozen-deadlock-20260905"], [ARCHIVED]: []},
			directories: [ROOT, ARCHIVED, `${ROOT}/8012.frozen-deadlock-20260905`],
		});
		const out = await run(fs, runArchiveSweep(OPTIONS));

		expect(rowsOf(out)).toMatchObject([{outcome: "archived", issue: 8012}]);
	});

	it("never archives a lane whose judgement is UNKNOWN", async () => {
		const ungraftable = JSON.parse(coderTemplateText());
		delete ungraftable.id;
		const fs = fakeFs({
			files: {
				[TEMPLATE]: JSON.stringify(ungraftable, null, "\t"),
				...lane("6037", REPLAYING),
			},
			dirs: {[ROOT]: ["6037"], [ARCHIVED]: []},
			directories: [ROOT, ARCHIVED, `${ROOT}/6037`],
		});
		const out = await run(fs, runArchiveSweep(OPTIONS));

		expect(out.code).toBe(0);
		expect(rowsOf(out)).toMatchObject([{outcome: "skipped", reason: "unjudgeable"}]);
		expect(fs.written.size).toBe(0);
	});

	it("judges a generated machine on its own fold, with no template to be unknown about", async () => {
		const fs = fakeFs({
			files: {[TEMPLATE]: coderTemplateText(), ...lane("6037", BROKEN, emittedLaneText())},
			dirs: {[ROOT]: ["6037"], [ARCHIVED]: []},
			directories: [ROOT, ARCHIVED, `${ROOT}/6037`],
		});
		const out = await run(fs, runArchiveSweep(OPTIONS));

		expect(rowsOf(out)).toMatchObject([{outcome: "archived", through: "current"}]);
	});

	it("asks the board only for the lanes whose log already failed to replay", async () => {
		const asked: number[] = [];
		const fs = mixedRoot();
		await run(
			fs,
			runArchiveSweep({
				...OPTIONS,
				closed: (issue) => {
					asked.push(issue);
					return board(issue);
				},
			}),
		);

		expect(asked).toEqual([6037, 8000]);
	});

	it("reads an absent root as no lanes rather than as a fault", async () => {
		const fs = fakeFs({files: {[TEMPLATE]: coderTemplateText()}, dirs: {}, directories: []});
		const out = await run(fs, runArchiveSweep(OPTIONS));

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({present: false, lanes: []});
	});

	it("refuses an unlistable root: the lane set is UNKNOWN, never empty", async () => {
		const fs = fakeFs({
			files: {[TEMPLATE]: coderTemplateText()},
			dirs: {},
			directories: [ROOT, ARCHIVED],
		});
		const out = await run(fs, runArchiveSweep(OPTIONS));

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stdout).toBe("");
	});

	it("refuses when a move that cleared both gates did not land, naming what did move", async () => {
		const fs = fakeFs({
			files: {[TEMPLATE]: coderTemplateText(), ...lane("6037", BROKEN), ...lane("7500", BROKEN)},
			dirs: {[ROOT]: ["6037", "7500"], [ARCHIVED]: []},
			directories: [ROOT, ARCHIVED, `${ROOT}/6037`, `${ROOT}/7500`],
			unrenamable: [`${ROOT}/7500`],
		});
		const out = await run(fs, runArchiveSweep(OPTIONS));

		expect(out.code).toBe(APPEND_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("6037: archived");
		expect(out.stderr.join("\n")).toContain("7500: skipped (unmoved)");
	});

	it("refuses when a lane moved and does not read back at the archived root", async () => {
		const fs = fakeFs({
			files: {[TEMPLATE]: coderTemplateText(), ...lane("6037", BROKEN)},
			dirs: {[ROOT]: ["6037"], [ARCHIVED]: []},
			directories: [ROOT, ARCHIVED, `${ROOT}/6037`],
			unprobeable: [`${ARCHIVED}/6037/workflow.json`],
		});
		const out = await run(fs, runArchiveSweep(OPTIONS));

		expect(out.code).toBe(MARKER_READBACK);
		expect(out.stderr.join("\n")).toContain("needs a human eye");
	});

	it("skips rather than buries a lane the archived root already holds", async () => {
		const fs = fakeFs({
			files: {
				[TEMPLATE]: coderTemplateText(),
				...lane("6037", BROKEN),
				[`${ARCHIVED}/6037/workflow.json`]: coderTemplateText(),
			},
			dirs: {[ROOT]: ["6037"], [ARCHIVED]: ["6037"]},
			directories: [ROOT, ARCHIVED, `${ROOT}/6037`, `${ARCHIVED}/6037`],
		});
		const out = await run(fs, runArchiveSweep(OPTIONS));

		expect(out.code).toBe(0);
		expect(rowsOf(out)).toMatchObject([{outcome: "skipped", reason: "occupied"}]);
		expect(fs.written.size).toBe(0);
	});
});
