/** The archive judgement, and the verb whose replay gate and claim retraction decide a move. */
import {Effect, type FileSystem, type Path} from "effect";
import {describe, expect, it} from "vitest";
import type {Claimant} from "../build/claim.ts";
import {fakeFs} from "../fakes.test-support.ts";
import type {VerbOutcome} from "../verb.ts";
import {judgeArchive} from "./archive.ts";
import {type ClaimRetractor, type ClaimsReader, runArchive} from "./archive-verb.ts";
import type {ClaimHoldReader} from "./claim-hold.ts";
import {
	APPEND_UNKNOWN,
	CLAIM_NOT_MINE,
	LANE_ABSENT,
	LANE_EXISTS,
	LANE_UNREADABLE,
	LOG_REPLAYS,
	MARKER_READBACK,
	MIGRATION_UNSAFE,
} from "./codes.ts";
import {seatsIn} from "./concurrency.ts";
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

/** `lane emit`'s shape: a machine whose `id` binds no committed template, so no candidate exists. */
const emittedLaneText = (): string => {
	const document = JSON.parse(coderTemplateText());
	document.id = "epic-5817";
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
		const text = emittedLaneText();

		expect(judgeArchive([coderTemplateText()], text, compiled(text), log("PASS"))).toMatchObject({
			_tag: "Unreplayable",
			through: "current",
		});
	});

	it("answers `Replays` for a generated machine that folds the log, having no second machine", () => {
		const text = emittedLaneText();

		expect(judgeArchive([coderTemplateText()], text, compiled(text), log("WIP", "DONE"))).toEqual({
			_tag: "Replays",
		});
	});

	it("is UNKNOWN when a committed template cannot be grafted at all", () => {
		const template = JSON.parse(coderTemplateText());
		delete template.id;
		const lane = coderTemplateText();

		expect(
			judgeArchive(
				[JSON.stringify(template, null, "\t")],
				lane,
				compiled(lane),
				log("WIP", "DONE"),
			),
		).toMatchObject({_tag: "Unjudgeable"});
	});

	it("is UNKNOWN when the grafted candidate does not compile", () => {
		const template = JSON.parse(coderTemplateText());
		delete template.machine.states;
		const lane = coderTemplateText();

		expect(
			judgeArchive(
				[JSON.stringify(template, null, "\t")],
				lane,
				compiled(lane),
				log("WIP", "DONE"),
			),
		).toMatchObject({_tag: "Unjudgeable"});
	});
});

const TOKEN = "lane:session-a:nonce-a";

/** One `lane-claim` marker as `readClaimants` hands it over. */
const claimant = (
	commentId: number,
	token: string,
	overrides: Partial<{authorized: boolean; session: string}> = {},
): Claimant => ({
	commentId,
	author: "usirin",
	createdAt: "2026-09-10T00:00:00.000Z",
	token,
	session: overrides.session ?? token.split(":")[1] ?? token,
	authorized: overrides.authorized ?? true,
});

const holds =
	(...claimants: ReadonlyArray<Claimant>): ClaimsReader<never> =>
	() =>
		Effect.succeed({
			_tag: "Read" as const,
			claimants,
			adopts: [],
			holder: claimants.find((one) => one.authorized) ?? null,
		});

const unclaimed: ClaimsReader<never> = holds();

/** Records what the verb retracted, in order, so a test can prove the sweep and its ordering. */
const recorder = (failOn: number | null = null) => {
	const deleted: number[] = [];
	const retract: ClaimRetractor<never> = (_issue, commentId) => {
		if (commentId === failOn) return Effect.succeed({_tag: "Failed" as const, reason: "403"});
		deleted.push(commentId);
		return Effect.succeed({_tag: "Retracted" as const});
	};
	return {deleted, retract};
};

const OPTIONS = {
	ref: {root: ROOT, lane: "6037"},
	archivedRoot: ARCHIVED,
	templatePaths: [TEMPLATE],
	issue: 6037,
	token: null,
	claims: unclaimed,
	retract: recorder().retract,
};

/** A lane on disk whose `ISSUE.PASS` from `queued` no machine has a cell for — the log that will never replay. */
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
	it("moves the lane to the archived root on the replay gate alone, and touches no log", async () => {
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
			retracted: [],
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
		// instead of reading the lane `current` — the state an unreplayable lane is in.
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

	it("moves a lane whose issue is still open — the arm the closed-issue gate used to shut", async () => {
		// The tail of lane 8810: a granted round walked, spent again, and a DONE appended into the
		// park that FAIL left. Its epic was open, which is what left the lane with no route at all.
		const bricked = [
			{task: "issue", event: "ISSUE.FAIL", at: "2026-09-10T06:15:00.000Z"},
			{task: "issue", event: "ISSUE.CLEARED", at: "2026-09-10T06:20:51.000Z", round: 3},
			{task: "issue", event: "ISSUE.UNBLOCKED", at: "2026-09-10T06:20:57.198Z"},
			{task: "issue", event: "ISSUE.FAIL", at: "2026-09-10T06:28:50.863Z"},
			{task: "issue", event: "ISSUE.DONE", at: "2026-09-10T06:35:12.051Z"},
		];
		const text = `${bricked.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
		const fs = fakeFs({
			files: {
				[TEMPLATE]: coderTemplateText(),
				[`${DIR}/workflow.json`]: coderTemplateText(),
				[`${DIR}/events.jsonl`]: text,
			},
			dirs: {[ROOT]: ["6037"], [ARCHIVED]: []},
			directories: [ROOT, ARCHIVED, DIR],
		});
		const out = await run(fs, runArchive(OPTIONS));

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({answer: "archived", to: MOVED});
		expect(fs.written.get(`${MOVED}/events.jsonl`)).toBe(text);
	});

	it("frees the lane's laneConcurrencyCap seat, which a bricked ledger held as unaccountable", async () => {
		const fs = brokenLane();
		const held: ClaimHoldReader<never> = () =>
			Effect.succeed({_tag: "Claimed" as const, token: TOKEN});

		const before = await Effect.runPromise(Effect.provide(seatsIn(ROOT, held), fs.layer));
		await run(fs, runArchive({...OPTIONS, claims: holds(claimant(11, TOKEN)), token: TOKEN}));
		const after = await Effect.runPromise(Effect.provide(seatsIn(ROOT, held), fs.layer));

		expect(before).toMatchObject({seats: [{lane: "6037", held: "unaccountable"}]});
		expect(after).toMatchObject({seats: []});
	});

	it("refuses a log that replays, before the claim thread is ever asked", async () => {
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
				claims: () => {
					asked += 1;
					return Effect.succeed({_tag: "Read", claimants: [], adopts: [], holder: null} as const);
				},
			}),
		);

		expect(out.code).toBe(LOG_REPLAYS);
		expect(asked).toBe(0);
		expect(fs.written.size).toBe(0);
	});

	it("refuses a generated machine's replaying log on LOG_REPLAYS, not as UNKNOWN", async () => {
		const fs = fakeFs({
			files: {
				[TEMPLATE]: coderTemplateText(),
				[`${DIR}/workflow.json`]: emittedLaneText(),
				[`${DIR}/events.jsonl`]: logText("WIP", "DONE"),
			},
			dirs: {[ROOT]: ["6037"], [ARCHIVED]: []},
			directories: [ROOT, ARCHIVED, DIR],
		});
		const out = await run(fs, runArchive(OPTIONS));

		expect(out.code).toBe(LOG_REPLAYS);
		expect(out.stderr.join("\n")).toContain(
			"replays through every machine that exists for this lane",
		);
		expect(fs.written.size).toBe(0);
	});

	it("refuses an UNKNOWN claim read rather than moving over it", async () => {
		const fs = brokenLane();
		const out = await run(
			fs,
			runArchive({
				...OPTIONS,
				claims: () => Effect.succeed({_tag: "Unknown", reason: "rate limited"} as const),
			}),
		);

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(fs.written.size).toBe(0);
	});

	it("archives a chore key, which names no issue and so carries no claim thread", async () => {
		const fs = brokenLane();
		let asked = 0;
		const out = await run(
			fs,
			runArchive({
				...OPTIONS,
				issue: null,
				claims: () => {
					asked += 1;
					return Effect.succeed({_tag: "Read", claimants: [], adopts: [], holder: null} as const);
				},
			}),
		);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({issue: null, retracted: []});
		expect(asked).toBe(0);
	});

	it("retracts every marker carrying the holder's token, and the adopt that authorized it", async () => {
		const fs = brokenLane();
		const {deleted, retract} = recorder();
		const claims: ClaimsReader<never> = () =>
			Effect.succeed({
				_tag: "Read" as const,
				claimants: [
					claimant(11, TOKEN),
					claimant(12, TOKEN),
					claimant(13, "lane:session-b:nonce-b"),
				],
				adopts: [
					{
						commentId: 14,
						author: "usirin",
						createdAt: "2026-09-10T00:00:00.000Z",
						adopted: "session-a",
						token: TOKEN,
						reason: "seat gone",
						authorized: true,
					},
					{
						commentId: 15,
						author: "usirin",
						createdAt: "2026-09-10T00:00:00.000Z",
						adopted: "session-z",
						token: "lane:session-z:nonce-z",
						reason: "another lane",
						authorized: true,
					},
				],
				holder: claimant(11, TOKEN),
			});
		const out = await run(fs, runArchive({...OPTIONS, claims, retract, token: TOKEN}));

		expect(out.code).toBe(0);
		// A sibling driver's marker (13) and another session's adopt (15) are untouched.
		expect(deleted).toEqual([11, 12, 14]);
		expect(JSON.parse(out.stdout).retracted).toEqual([11, 12, 14]);
	});

	it("refuses a live claim this caller did not name, leaving the directory and the marker", async () => {
		const fs = brokenLane();
		const {deleted, retract} = recorder();
		const out = await run(
			fs,
			runArchive({...OPTIONS, claims: holds(claimant(11, TOKEN)), retract, token: null}),
		);

		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(deleted).toEqual([]);
		expect(fs.written.size).toBe(0);
		expect(out.stderr.join("\n")).toContain("fabrika lane adopt 6037 --session session-a");
	});

	it("refuses a retraction that failed, and never moves over the UNKNOWN it leaves", async () => {
		const fs = brokenLane();
		const {deleted, retract} = recorder(12);
		const claims = holds(claimant(11, TOKEN), claimant(12, TOKEN));
		const out = await run(fs, runArchive({...OPTIONS, claims, retract, token: TOKEN}));

		expect(out.code).toBe(APPEND_UNKNOWN);
		expect(deleted).toEqual([11]);
		expect(fs.written.size).toBe(0);
	});

	it("retracts before it moves, so a failed move never strands a claim on a lane that is gone", async () => {
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
		const {deleted, retract} = recorder();
		const out = await run(
			fs,
			runArchive({...OPTIONS, claims: holds(claimant(11, TOKEN)), retract, token: TOKEN}),
		);

		expect(out.code).toBe(APPEND_UNKNOWN);
		expect(deleted).toEqual([11]);
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
