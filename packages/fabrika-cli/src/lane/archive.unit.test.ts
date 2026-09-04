/** The archive judgement, and the verb whose two gates decide whether a lane directory moves. */
import {Effect, type FileSystem, type Path} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import type {VerbOutcome} from "../verb.ts";
import {judgeArchive} from "./archive.ts";
import {type ClosureState, runArchive} from "./archive-verb.ts";
import {
	APPEND_UNKNOWN,
	ISSUE_LIVE,
	ISSUE_UNRESOLVED,
	LANE_ABSENT,
	LANE_EXISTS,
	LANE_UNREADABLE,
	LOG_REPLAYS,
	MARKER_READBACK,
	MIGRATION_UNSAFE,
} from "./codes.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";
import type {LogEntry} from "./fold.ts";
import {runHistory} from "./history-verb.ts";
import {type CompiledLane, compileText} from "./machine.ts";
import {runMigrate} from "./migrate-verb.ts";
import {runReconcile} from "./reconcile-verb.ts";
import {DEFAULT_ARCHIVED_LANES_ROOT, DEFAULT_LANES_ROOT} from "./store.ts";

const ROOT = DEFAULT_LANES_ROOT;
const ARCHIVED = DEFAULT_ARCHIVED_LANES_ROOT;
const DIR = `${ROOT}/6037`;
const MOVED = `${ARCHIVED}/6037`;
const TEMPLATE = "/repo/templates/coder.workflow.json";
const CHORE_TEMPLATE = "/repo/templates/chore.workflow.json";

const compiled = (text: string): CompiledLane => {
	const result = compileText(text);
	if (result._tag === "Malformed") throw new Error(result.defects.join("; "));
	return result.lane;
};

const log = (...events: ReadonlyArray<string>): ReadonlyArray<LogEntry> =>
	events.map((event) => ({task: "issue", event: `ISSUE.${event}`, at: "2026-08-19T00:00:00.000Z"}));

const logText = (...events: ReadonlyArray<string>): string =>
	`${log(...events)
		.map((entry) => JSON.stringify(entry))
		.join("\n")}\n`;

/**
 * A lane machine carrying a cell the committed template does not: the shape whose log replays
 * through the lane's own machine and refuses through the template.
 */
const widenedLaneText = (): string => {
	const document = JSON.parse(coderTemplateText());
	document.machine.states.pipeline.states.issue.states.queued.on["ISSUE.PASS"] = "shipped";
	return JSON.stringify(document, null, "\t");
};

describe("judgeArchive", () => {
	it("names the lane's own machine when the log will not replay through it", () => {
		const text = coderTemplateText();

		expect(judgeArchive([text], text, compiled(text), log("PASS"))).toMatchObject({
			_tag: "Unreplayable",
			through: "current",
		});
	});

	it("names the committed template when only that machine refuses the log", () => {
		const lane = widenedLaneText();

		expect(judgeArchive([coderTemplateText()], lane, compiled(lane), log("PASS"))).toMatchObject({
			_tag: "Unreplayable",
			through: "candidate",
		});
	});

	it("answers `Replays` for a log both machines fold, so nothing is archivable", () => {
		const text = coderTemplateText();

		expect(judgeArchive([text], text, compiled(text), log("WIP", "DONE"))).toEqual({
			_tag: "Replays",
		});
	});

	it("folds the lane's own machine BEFORE looking for a candidate, so a generated one still judges", () => {
		const emitted = JSON.parse(coderTemplateText());
		emitted.id = "epic-5817";
		const text = JSON.stringify(emitted, null, "\t");

		expect(judgeArchive([coderTemplateText()], text, compiled(text), log("PASS"))).toMatchObject({
			_tag: "Unreplayable",
			through: "current",
		});
	});

	it("is UNKNOWN, never `Replays`, when a generated machine's replaying log has no candidate", () => {
		const emitted = JSON.parse(coderTemplateText());
		emitted.id = "epic-5817";
		const text = JSON.stringify(emitted, null, "\t");

		expect(
			judgeArchive([coderTemplateText()], text, compiled(text), log("WIP", "DONE")),
		).toMatchObject({_tag: "Unjudgeable"});
	});
});

const closes = (state: ClosureState) => () => Effect.succeed(state);
const closed = closes({_tag: "Closed", reason: "completed"});

const OPTIONS = {
	ref: {root: ROOT, lane: "6037"},
	archivedRoot: ARCHIVED,
	templatePaths: [TEMPLATE],
	issue: 6037,
	closed,
};

/** A lane on disk whose `ISSUE.PASS` from `queued` no machine has a cell for — the #7803 shape. */
const brokenLane = (
	extra: Record<string, string | null> = {},
	directories: ReadonlyArray<string> = [],
) =>
	fakeFs({
		files: {
			[TEMPLATE]: coderTemplateText(),
			[`${DIR}/workflow.json`]: coderTemplateText(),
			[`${DIR}/events.jsonl`]: logText("PASS"),
			...extra,
		},
		dirs: {[ROOT]: ["6037"], [ARCHIVED]: []},
		directories: [ROOT, ARCHIVED, DIR, ...directories],
	});

const run = (
	fs: ReturnType<typeof fakeFs>,
	eff: Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path>,
) => Effect.runPromise(Effect.provide(eff, fs.layer));

describe("lane archive", () => {
	it("moves the lane to the archived root with both gates held, and touches no log", async () => {
		const fs = brokenLane();
		const out = await run(fs, runArchive(OPTIONS));

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "archived",
			lane: "6037",
			issue: 6037,
			from: DIR,
			to: MOVED,
			through: "current",
		});
		// The bytes reached the destination unchanged, and nothing was written to the log in place.
		expect(fs.written.get(`${MOVED}/events.jsonl`)).toBe(logText("PASS"));
		expect(fs.written.has(`${DIR}/events.jsonl`)).toBe(false);
	});

	it("leaves the archived record readable through `lane history` at the archived root", async () => {
		const fs = brokenLane();
		await run(fs, runArchive(OPTIONS));
		const out = await run(fs, runHistory({root: ARCHIVED, lane: "6037"}));

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual([...log("PASS")]);
	});

	it("takes the lane out of both sweeps, neither of which is ever handed the archived root", async () => {
		// A machine that differs from the template, so the migrate sweep reaches its judgement
		// instead of reading the lane `current` — the state the eight lanes of #7803 are in.
		const fs = fakeFs({
			files: {
				[TEMPLATE]: coderTemplateText(),
				[`${DIR}/workflow.json`]: widenedLaneText(),
				[`${DIR}/events.jsonl`]: logText("PASS"),
			},
			dirs: {[ROOT]: ["6037"], [ARCHIVED]: []},
			directories: [ROOT, ARCHIVED, DIR],
		});
		const migrate = () =>
			runMigrate({
				roots: [{root: ROOT, templatePaths: [TEMPLATE]}],
				check: true,
				expectations: null,
			});
		const reconcile = () =>
			runReconcile({
				roots: [{root: ROOT, templatePaths: [TEMPLATE]}],
				check: true,
				now: "2026-09-04T00:00:00.000Z",
				closures: () => Effect.succeed({_tag: "Unknown", reason: "never asked"} as const),
			});

		const migrateBefore = await run(fs, migrate());
		const reconcileBefore = await run(fs, reconcile());
		const archived = await run(fs, runArchive(OPTIONS));
		const migrateAfter = await run(fs, migrate());
		const reconcileAfter = await run(fs, reconcile());

		expect(migrateBefore.code).toBe(MIGRATION_UNSAFE);
		expect(JSON.parse(reconcileBefore.stdout).lanes).toHaveLength(1);
		expect(archived.code).toBe(0);
		expect(migrateAfter.code).toBe(0);
		expect(JSON.parse(migrateAfter.stdout).lanes).toEqual([]);
		expect(JSON.parse(reconcileAfter.stdout).lanes).toEqual([]);
	});

	it("refuses an open issue, leaving the directory where it was", async () => {
		const fs = brokenLane();
		const out = await run(fs, runArchive({...OPTIONS, closed: closes({_tag: "Open"})}));

		expect(out.code).toBe(ISSUE_LIVE);
		expect(out.stdout).toBe("");
		expect(fs.written.size).toBe(0);
	});

	it("refuses a log that replays, before the board is ever asked", async () => {
		let asked = 0;
		const fs = fakeFs({
			files: {
				[TEMPLATE]: coderTemplateText(),
				[`${DIR}/workflow.json`]: coderTemplateText(),
				[`${DIR}/events.jsonl`]: logText("WIP", "DONE"),
			},
			dirs: {[ROOT]: ["6037"], [ARCHIVED]: []},
			directories: [ROOT, ARCHIVED, DIR],
		});
		const out = await run(
			fs,
			runArchive({
				...OPTIONS,
				closed: () => {
					asked += 1;
					return Effect.succeed({_tag: "Closed", reason: null} as const);
				},
			}),
		);

		expect(out.code).toBe(LOG_REPLAYS);
		expect(asked).toBe(0);
		expect(fs.written.size).toBe(0);
	});

	it("refuses an UNKNOWN board read rather than moving over it", async () => {
		const fs = brokenLane();
		const out = await run(
			fs,
			runArchive({...OPTIONS, closed: closes({_tag: "Unknown", reason: "rate limited"})}),
		);

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(fs.written.size).toBe(0);
	});

	it("refuses a chore key, whose lane can never satisfy the closed-issue gate", async () => {
		const fs = brokenLane();
		const out = await run(fs, runArchive({...OPTIONS, issue: null}));

		expect(out.code).toBe(ISSUE_UNRESOLVED);
		expect(fs.written.size).toBe(0);
	});

	it("refuses a lane that is not there", async () => {
		const fs = fakeFs({
			files: {[TEMPLATE]: coderTemplateText()},
			dirs: {[ROOT]: []},
			directories: [ROOT, ARCHIVED],
		});
		const out = await run(fs, runArchive(OPTIONS));

		expect(out.code).toBe(LANE_ABSENT);
	});

	it("refuses rather than moving onto an archived lane already at the destination", async () => {
		const fs = brokenLane({[`${MOVED}/workflow.json`]: coderTemplateText()}, [MOVED]);
		const out = await run(fs, runArchive(OPTIONS));

		expect(out.code).toBe(LANE_EXISTS);
		expect(fs.written.size).toBe(0);
	});

	it("refuses a move that did not land, and never reports the lane as archived", async () => {
		const fs = fakeFs({
			files: {
				[TEMPLATE]: coderTemplateText(),
				[`${DIR}/workflow.json`]: coderTemplateText(),
				[`${DIR}/events.jsonl`]: logText("PASS"),
			},
			dirs: {[ROOT]: ["6037"], [ARCHIVED]: []},
			directories: [ROOT, ARCHIVED, DIR],
			unrenamable: [DIR],
		});
		const out = await run(fs, runArchive(OPTIONS));

		expect(out.code).toBe(APPEND_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("refuses a move that reported success and does not read back", async () => {
		const fs = fakeFs({
			files: {
				[TEMPLATE]: coderTemplateText(),
				[`${DIR}/workflow.json`]: coderTemplateText(),
				[`${DIR}/events.jsonl`]: logText("PASS"),
			},
			dirs: {[ROOT]: ["6037"], [ARCHIVED]: []},
			directories: [ROOT, ARCHIVED, DIR],
			unprobeable: [`${MOVED}/workflow.json`],
		});
		const out = await run(fs, runArchive(OPTIONS));

		expect(out.code).toBe(MARKER_READBACK);
	});

	it("judges a relocated root's lane by its own machine id, with both templates offered", async () => {
		const fs = brokenLane({[CHORE_TEMPLATE]: coderTemplateText()});
		const out = await run(fs, runArchive({...OPTIONS, templatePaths: [CHORE_TEMPLATE, TEMPLATE]}));

		expect(out.code).toBe(0);
	});
});
