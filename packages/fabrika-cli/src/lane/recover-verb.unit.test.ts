/** `lane recover` — the lane-9185 shape, what it records, and what it refuses to record. */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import type {ClaimStanding} from "../build/dead-claim.ts";
import {fakeFs} from "../fakes.test-support.ts";
import {appendText} from "../io/fs.ts";
import {answer, refuse} from "../verb.ts";
import {APPEND_UNKNOWN, LANE_UNREADABLE, PROOF_ABSENT} from "./codes.ts";
import {coderTemplateText, parkCauseRead} from "./fixtures.test-support.ts";
import type {ProofOutcome, ProveOptions} from "./prove-verb.ts";
import {proofLabelOf} from "./prove-verb.ts";
import {type BranchRead, type PullsRead, runRecover} from "./recover-verb.ts";
import {DEFAULT_CHORES_ROOT, DEFAULT_LANES_ROOT} from "./store.ts";

const at = (n: number): string => `2026-09-15T18:1${n}:00.000Z`;

const line = (event: string, when: string, task = "issue"): string =>
	`${JSON.stringify({task, event: `${task.toUpperCase()}.${event}`, at: when})}\n`;

/**
 * The coder machine with its one region duplicated under a second task, so one lane can stand in
 * `review` twice — the shape a preview taken off the pre-sweep fold gets wrong.
 */
const twoRegionTemplate = (): string => {
	const doc = JSON.parse(coderTemplateText());
	const pipeline = doc.machine.states.pipeline;
	pipeline.states.child = JSON.parse(
		JSON.stringify(pipeline.states.issue).replaceAll("ISSUE.", "CHILD."),
	);
	doc.machine.context.child = {...doc.machine.context.issue};
	return JSON.stringify(doc);
};

/** Lane 9185's shape: the builder's work recorded, the reviewer's PASS never reaching the log. */
const REVIEWING_LOG = `${line("WIP", at(0))}${line("DONE", at(1))}`;

/** A lane still in `build`, whose leaf owes nothing: an open PR proves a `DONE` for a live builder too. */
const BUILDING_LOG = line("WIP", at(0));

const REVIEW_FOLD = JSON.stringify({pipeline: {issue: "review"}});

interface LaneFixture {
	readonly lane: string;
	readonly log?: string;
	readonly workflow?: string | null;
}

const tree = (lanes: ReadonlyArray<LaneFixture>) => {
	const files: Record<string, string | null> = {};
	const names: string[] = [];
	for (const {lane, log, workflow} of lanes) {
		names.push(lane);
		const value = workflow === undefined ? coderTemplateText() : workflow;
		if (value !== null) files[`${DEFAULT_LANES_ROOT}/${lane}/workflow.json`] = value;
		if (log !== undefined) files[`${DEFAULT_LANES_ROOT}/${lane}/events.jsonl`] = log;
	}
	return fakeFs({files, dirs: {[DEFAULT_LANES_ROOT]: names}, directories: [DEFAULT_LANES_ROOT]});
};

/** A prover scripted per lane, recording every question the sweep and the append asked it. */
const sweep = (
	fs: ReturnType<typeof fakeFs>,
	proofs: (options: ProveOptions) => ReturnType<typeof answer> | ReturnType<typeof refuse>,
	check = false,
	roots: ReadonlyArray<string> = [DEFAULT_LANES_ROOT],
) => {
	const asked: ProveOptions[] = [];
	const prove = (options: ProveOptions): Effect.Effect<ProofOutcome> =>
		Effect.sync(() => {
			asked.push(options);
			const outcome = proofs(options);
			return {
				...outcome,
				deferred: [],
				routed: [],
				partial: null,
				landed: [],
				diagnosis: false,
				proof: proofLabelOf(outcome),
			};
		});
	return Effect.runPromise(
		Effect.provide(
			runRecover({
				roots,
				check,
				spawns: null,
				prove,
				parkCause: parkCauseRead(),
				repo: "o/r",
				cwd: "/checkout",
				env: {},
			}),
			fs.layer,
		),
	).then((outcome) => ({outcome, asked, fs}));
};

const proven = () =>
	answer(
		JSON.stringify({
			proof: "proven",
			event: "PASS",
			task: "issue",
			evidence: {kind: "head-verdicts", pr: 9188},
		}),
	);

const rows = (stdout: string): ReadonlyArray<Record<string, unknown>> =>
	(JSON.parse(stdout) as {lanes: ReadonlyArray<Record<string, unknown>>}).lanes;

const logOf = (fs: ReturnType<typeof fakeFs>, lane: string): string | undefined =>
	fs.written.get(`${DEFAULT_LANES_ROOT}/${lane}/events.jsonl`);

describe("runRecover — the lane-9185 shape", () => {
	it("records the PASS a killed reviewer proved on the PR and never wrote to the log", async () => {
		const {outcome, fs} = await sweep(tree([{lane: "9185", log: REVIEWING_LOG}]), proven);
		expect(outcome.code).toBe(0);
		const [row] = rows(outcome.stdout);
		expect(row).toMatchObject({
			key: "9185",
			verdict: "recovered",
			task: "issue",
			state: "review",
			event: "PASS",
			proof: "proven",
			from: REVIEW_FOLD,
			to: JSON.stringify({pipeline: {issue: "ship"}}),
		});
		expect(logOf(fs, "9185")).toContain('"ISSUE.PASS"');
	});

	it("leaves a lane whose PR carries no verdict exactly where it is", async () => {
		const {outcome, fs} = await sweep(tree([{lane: "9185", log: REVIEWING_LOG}]), () =>
			refuse(PROOF_ABSENT, "fabrika lane prove: unproven — no verdict at the head"),
		);
		expect(outcome.code).toBe(0);
		const [row] = rows(outcome.stdout);
		expect(row).toMatchObject({
			key: "9185",
			verdict: "unproven",
			event: "PASS",
			proof: null,
			proofCode: PROOF_ABSENT,
		});
		expect(String(row?.reason)).toContain("no verdict at the head");
		expect(logOf(fs, "9185")).toBeUndefined();
	});

	it("asks the board once about a lane it cannot recover, and twice about one it can", async () => {
		const unprovable = await sweep(tree([{lane: "9185", log: REVIEWING_LOG}]), () =>
			refuse(PROOF_ABSENT, "unproven"),
		);
		expect(unprovable.asked).toHaveLength(1);

		// The second read is `lane transition`'s own gate, which is the append declining to take this
		// sweep's word for the proof rather than a read this verb makes twice.
		const provable = await sweep(tree([{lane: "9185", log: REVIEWING_LOG}]), proven);
		expect(provable.asked).toHaveLength(2);
		expect(provable.asked.map((options) => options.event)).toEqual(["PASS", "PASS"]);
	});
});

describe("runRecover — what it will not record", () => {
	it("records nothing on a `not-required` answer and reports it as its own row", async () => {
		const {outcome, fs} = await sweep(tree([{lane: "9185", log: REVIEWING_LOG}]), () =>
			answer(JSON.stringify({proof: "not-required", event: "PASS", task: "issue"})),
		);
		expect(outcome.code).toBe(0);
		expect(rows(outcome.stdout)[0]).toMatchObject({
			verdict: "unproven",
			proof: "not-required",
			proofCode: 0,
		});
		expect(logOf(fs, "9185")).toBeUndefined();
	});

	it("records nothing on an `uncontradicted` answer, which is the park's negative claim", async () => {
		const {outcome, fs} = await sweep(tree([{lane: "9185", log: REVIEWING_LOG}]), () =>
			answer(JSON.stringify({proof: "uncontradicted", event: "BLOCKED", task: "issue"})),
		);
		expect(rows(outcome.stdout)[0]).toMatchObject({verdict: "unproven", proof: "uncontradicted"});
		expect(logOf(fs, "9185")).toBeUndefined();
	});

	it("never asks about a BLOCKED — the owed event out of a review cell is the PASS alone", async () => {
		const {asked} = await sweep(tree([{lane: "9185", log: REVIEWING_LOG}]), proven);
		expect(asked.map((options) => options.event)).not.toContain("BLOCKED");
	});

	it("spends no read on a terminal lane and reports it as terminal", async () => {
		const terminal = `${REVIEWING_LOG}${line("PASS", at(2))}${line("DONE", at(3))}`;
		const {outcome, asked} = await sweep(tree([{lane: "9185", log: terminal}]), proven);
		expect(asked).toHaveLength(0);
		expect(rows(outcome.stdout)[0]).toMatchObject({key: "9185", verdict: "terminal"});
	});

	it("reports a non-terminal lane owing nothing as `current`, unread", async () => {
		const {outcome, asked} = await sweep(tree([{lane: "9185"}]), proven);
		expect(asked).toHaveLength(0);
		expect(rows(outcome.stdout)[0]).toMatchObject({key: "9185", verdict: "current"});
	});
});

describe("runRecover — the sweep", () => {
	it("--check reports the move it would make and appends nothing", async () => {
		const {outcome, asked, fs} = await sweep(
			tree([{lane: "9185", log: REVIEWING_LOG}]),
			proven,
			true,
		);
		expect(rows(outcome.stdout)[0]).toMatchObject({
			verdict: "recoverable",
			from: REVIEW_FOLD,
			to: JSON.stringify({pipeline: {issue: "ship"}}),
		});
		expect(asked).toHaveLength(1);
		expect(logOf(fs, "9185")).toBeUndefined();
		expect(outcome.stderr.join(" ")).toContain("check only, nothing appended");
	});

	it("judges each lane on its own, so an unreadable one is a row rather than the end", async () => {
		const {outcome, fs} = await sweep(
			tree([
				{lane: "9100", log: "{ not json\n"},
				{lane: "9185", log: REVIEWING_LOG},
			]),
			proven,
		);
		expect(outcome.code).toBe(0);
		expect(rows(outcome.stdout).map((row) => [row.key, row.verdict])).toEqual([
			["9100", "unreadable"],
			["9185", "recovered"],
		]);
		expect(logOf(fs, "9185")).toContain('"ISSUE.PASS"');
	});

	it("asks the PASS of a lane in review, and asks a lane in build nothing at all", async () => {
		// `claimOf`'s build arm proves a `DONE` off one open PR, which a builder in a repair round has
		// for the whole round — so a sweep owing a `DONE` would fold that lane to `review` under the
		// live shell. The lane is reported `current` instead, and costs no board read.
		const {asked, outcome} = await sweep(
			tree([
				{lane: "9100", log: BUILDING_LOG},
				{lane: "9185", log: REVIEWING_LOG},
			]),
			() => refuse(PROOF_ABSENT, "unproven"),
		);
		expect(asked.map((options) => [options.lane, options.event])).toEqual([["9185", "PASS"]]);
		expect(rows(outcome.stdout).map((row) => [row.key, row.verdict])).toEqual([
			["9100", "current"],
			["9185", "unproven"],
		]);
	});

	it("re-derives the preview per append, so a second region does not leave a state the first left", async () => {
		const log = `${REVIEWING_LOG}${line("WIP", at(2), "child")}${line("DONE", at(3), "child")}`;
		const {outcome} = await sweep(
			tree([{lane: "9185", log, workflow: twoRegionTemplate()}]),
			proven,
			true,
		);
		expect(rows(outcome.stdout).map((row) => [row.task, row.from, row.to])).toEqual([
			[
				"issue",
				JSON.stringify({pipeline: {issue: "review", child: "review"}}),
				JSON.stringify({pipeline: {issue: "ship", child: "review"}}),
			],
			[
				"child",
				JSON.stringify({pipeline: {issue: "ship", child: "review"}}),
				JSON.stringify({pipeline: {issue: "ship", child: "ship"}}),
			],
		]);
	});

	it("reports where the append landed, not where it predicted, when a writer lands in between", async () => {
		// The sweep folds outside any lock and `lane transition` re-folds inside it, so the child
		// region's own PASS landing between the two makes preview and append disagree. The row a driver
		// acts on carries the append's answer; the preview would name a state the lane is not in, on an
		// exit-0 sweep.
		const log = `${REVIEWING_LOG}${line("WIP", at(2), "child")}${line("DONE", at(3), "child")}`;
		const fs = fakeFs({
			files: {
				[`${DEFAULT_LANES_ROOT}/9185/workflow.json`]: twoRegionTemplate(),
				[`${DEFAULT_LANES_ROOT}/9185/events.jsonl`]: log,
			},
			dirs: {[DEFAULT_LANES_ROOT]: ["9185"]},
			directories: [DEFAULT_LANES_ROOT],
		});
		let asks = 0;
		const {outcome} = await sweep(fs, (options) => {
			if (options.task !== "issue") return refuse(PROOF_ABSENT, "unproven");
			asks += 1;
			// The append's own gate read is the last thing before its lock, so a write here is exactly
			// the concurrent writer this row exists to survive.
			if (asks === 2) {
				Effect.runSync(
					Effect.provide(
						appendText(`${DEFAULT_LANES_ROOT}/9185/events.jsonl`, line("PASS", at(4), "child")),
						fs.layer,
					),
				);
			}
			return proven();
		});
		expect(outcome.code).toBe(0);
		const [recovered, second] = rows(outcome.stdout);
		expect(recovered).toMatchObject({
			task: "issue",
			verdict: "recovered",
			from: JSON.stringify({pipeline: {issue: "review", child: "review"}}),
			to: JSON.stringify({pipeline: {issue: "ship", child: "ship"}}),
		});
		// What the offline preview says, and what the row would have reported had it kept it.
		expect(recovered?.to).not.toBe(JSON.stringify({pipeline: {issue: "ship", child: "review"}}));
		// The landing rides into the next region's `from`, so one stale read does not compound.
		expect(second).toMatchObject({
			task: "child",
			from: JSON.stringify({pipeline: {issue: "ship", child: "ship"}}),
		});
	});

	it("reports a lane that only lost the ledger lock as `contended`, with the re-run on stderr", async () => {
		process.env.FABRIKA_LANE_LOCK_BUDGET_MS = "120";
		const lock = `${DEFAULT_LANES_ROOT}/9185/events.lock`;
		const fs = fakeFs({
			files: {
				[`${DEFAULT_LANES_ROOT}/9185/workflow.json`]: coderTemplateText(),
				[`${DEFAULT_LANES_ROOT}/9185/events.jsonl`]: REVIEWING_LOG,
			},
			dirs: {[DEFAULT_LANES_ROOT]: ["9185"]},
			directories: [DEFAULT_LANES_ROOT],
			mkdirExisting: [lock],
			mtimes: {[lock]: new Date()},
		});
		try {
			const {outcome} = await sweep(fs, proven);

			// Exit 0: nothing is UNKNOWN here — the event was never validated, so the lane is knowably
			// still missing it and the same event is still the right one to send.
			expect(outcome.code).toBe(0);
			const [row] = rows(outcome.stdout);
			expect(row).toMatchObject({key: "9185", verdict: "contended", event: "PASS"});
			expect(String(row?.reason)).toContain("re-run the sweep");
			expect(outcome.stderr.join(" ")).toContain("only lost the ledger lock");
			expect(logOf(fs, "9185")).toBeUndefined();
		} finally {
			delete process.env.FABRIKA_LANE_LOCK_BUDGET_MS;
		}
	});

	it("refuses the run when an append it tried did not land, naming that lane and the recovered ones", async () => {
		const fs = fakeFs({
			files: {
				[`${DEFAULT_LANES_ROOT}/9185/workflow.json`]: coderTemplateText(),
				[`${DEFAULT_LANES_ROOT}/9185/events.jsonl`]: REVIEWING_LOG,
			},
			dirs: {[DEFAULT_LANES_ROOT]: ["9185"]},
			directories: [DEFAULT_LANES_ROOT],
			unwritable: [`${DEFAULT_LANES_ROOT}/9185/events.jsonl`],
		});
		const {outcome} = await sweep(fs, proven);
		expect(outcome.code).toBe(APPEND_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join(" ")).toContain("9185");
		expect(outcome.stderr.join(" ")).toContain("UNKNOWN");
	});

	it("refuses rather than reporting an empty sweep when a root is there and cannot be listed", async () => {
		const fs = fakeFs({dirs: {[DEFAULT_LANES_ROOT]: null}, directories: [DEFAULT_LANES_ROOT]});
		const {outcome} = await sweep(fs, proven);
		expect(outcome.code).toBe(LANE_UNREADABLE);
		expect(outcome.stderr.join(" ")).toContain("UNKNOWN, never empty");
	});

	it("lists every root before it appends to any, so an unlistable one discards no lane", async () => {
		// Listing lazily refused from inside the sweep, after the first root's appends had landed: the
		// run exited 11 with empty stdout and named none of the lanes it had just moved.
		const fs = fakeFs({
			files: {
				[`${DEFAULT_LANES_ROOT}/9185/workflow.json`]: coderTemplateText(),
				[`${DEFAULT_LANES_ROOT}/9185/events.jsonl`]: REVIEWING_LOG,
			},
			dirs: {[DEFAULT_LANES_ROOT]: ["9185"], [DEFAULT_CHORES_ROOT]: null},
			directories: [DEFAULT_LANES_ROOT, DEFAULT_CHORES_ROOT],
		});
		const {outcome, asked} = await sweep(fs, proven, false, [
			DEFAULT_LANES_ROOT,
			DEFAULT_CHORES_ROOT,
		]);
		expect(outcome.code).toBe(LANE_UNREADABLE);
		expect(outcome.stderr.join(" ")).toContain("Nothing was appended");
		expect(asked).toHaveLength(0);
		expect(logOf(fs, "9185")).toBeUndefined();
	});

	it("reads an absent root as holding no lanes, which is not a fault", async () => {
		const {outcome} = await sweep(fakeFs({}), proven);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({
			scanned: [{root: DEFAULT_LANES_ROOT, present: false, lanes: 0}],
			lanes: [],
		});
	});
});

/** A build claim standing past the builder's budget, with a token an assertion can name. */
const dead = (): ClaimStanding => ({
	_tag: "Dead",
	token: "build:gone-session:341861f5",
	ageMinutes: 7200,
	budgetMinutes: 40,
	stack: [],
	scanned: 1,
});

/** The board saying no PR links the issue — the trace that means "nothing published". */
const noPull = (): PullsRead => ({
	_tag: "Read",
	trace: {_tag: "None", why: "no open PR links #7778"},
	scanned: 0,
});

const spawnSweep = (
	fs: ReturnType<typeof fakeFs>,
	claim: ClaimStanding,
	branches: BranchRead = {_tag: "Read", branches: []},
	check = false,
	pull: PullsRead = noPull(),
) => {
	const claimed: number[] = [];
	const asked: number[] = [];
	const prove = (): Effect.Effect<ProofOutcome> =>
		Effect.sync(() => {
			// The spawn arm asks this prover nothing — its publication read is its own — so the only
			// question reaching here is the one `runTransition` asks about the event it appends, and a
			// `BLOCKED` out of a build leaf claims no artifact.
			const outcome = answer(JSON.stringify({proof: null}));
			return {
				...outcome,
				deferred: [],
				routed: [],
				partial: null,
				landed: [],
				diagnosis: false,
				proof: proofLabelOf(outcome),
			};
		});
	return Effect.runPromise(
		Effect.provide(
			runRecover({
				roots: [DEFAULT_LANES_ROOT],
				check,
				spawns: {
					claim: (issue: number) =>
						Effect.sync(() => {
							claimed.push(issue);
							return claim;
						}),
					branches: () => Effect.succeed(branches),
					pulls: (issue: number) =>
						Effect.sync(() => {
							asked.push(issue);
							return pull;
						}),
				},
				prove,
				parkCause: parkCauseRead(),
				repo: "o/r",
				cwd: "/checkout",
				env: {},
			}),
			fs.layer,
		),
	).then((outcome) => ({outcome, claimed, asked, fs}));
};

const building = () => tree([{lane: "7778", log: BUILDING_LOG}]);

/** The coder machine with its `WIP` landing in `build:ui` — the rendered-surface builder's leaf. */
const uiTemplate = (): string => {
	const doc = JSON.parse(coderTemplateText());
	doc.machine.states.pipeline.states.issue.states.queued.on["ISSUE.WIP"] = "build:ui";
	return JSON.stringify(doc);
};

/**
 * The coder machine re-emitted as one epic lane: a child region named for its own issue, beside the
 * tail region whose `epic_<n>` name is what makes every other task a child.
 */
const childTemplate = (): string => {
	const doc = JSON.parse(coderTemplateText());
	const pipeline = doc.machine.states.pipeline;
	const region = JSON.stringify(pipeline.states.issue);
	pipeline.states.issue_9301 = JSON.parse(region.replaceAll("ISSUE.", "ISSUE_9301."));
	pipeline.states.epic_9241 = JSON.parse(region.replaceAll("ISSUE.", "EPIC_9241."));
	delete pipeline.states.issue;
	doc.machine.context.issue_9301 = {...doc.machine.context.issue};
	doc.machine.context.epic_9241 = {...doc.machine.context.issue};
	delete doc.machine.context.issue;
	return JSON.stringify(doc);
};

const BUILD_FOLD = JSON.stringify({pipeline: {issue: "build"}});
const BLOCKED_FOLD = JSON.stringify({pipeline: {issue: "blocked"}});

describe("runRecover --spawns — the lane-7778 shape", () => {
	it("parks the lane a dead builder left with no branch and no PR", async () => {
		const {outcome, claimed, fs} = await spawnSweep(building(), dead());
		expect(outcome.code).toBe(0);
		const [row] = rows(outcome.stdout);
		expect(row).toMatchObject({
			key: "7778",
			verdict: "parked",
			task: "issue",
			state: "build",
			event: "BLOCKED",
			cause: "spawn-dead",
			from: BUILD_FOLD,
			to: BLOCKED_FOLD,
		});
		expect(claimed).toEqual([7778]);
		const log = logOf(fs, "7778") ?? "";
		expect(log).toContain('"ISSUE.BLOCKED"');
		expect(log).toContain("spawn-dead");
	});

	it("leaves a live-but-quiet builder alone, ledger untouched", async () => {
		const {outcome, fs} = await spawnSweep(building(), {
			_tag: "Alive",
			token: "build:live-session:9092",
			ageMinutes: 12,
			budgetMinutes: 40,
			scanned: 1,
		});
		expect(outcome.code).toBe(0);
		const [row] = rows(outcome.stdout);
		expect(row).toMatchObject({key: "7778", verdict: "working", state: "build"});
		expect(row?.reason).toContain("may still be working");
		expect(logOf(fs, "7778")).toBeUndefined();
	});

	it("leaves a lane whose branch still carries the dead builder's commits", async () => {
		const {outcome, fs} = await spawnSweep(building(), dead(), {
			_tag: "Read",
			branches: ["build/7778-editor-focus-4f2a"],
		});
		expect(outcome.code).toBe(0);
		const [row] = rows(outcome.stdout);
		expect(row).toMatchObject({key: "7778", verdict: "working"});
		expect(row?.reason).toContain("build/7778-editor-focus-4f2a");
		expect(logOf(fs, "7778")).toBeUndefined();
	});

	it("leaves a lane whose builder published a PR before it went quiet", async () => {
		const {outcome, fs} = await spawnSweep(building(), dead(), undefined, false, {
			_tag: "Read",
			trace: {_tag: "One", pr: 9257},
			scanned: 1,
		});
		expect(outcome.code).toBe(0);
		const [row] = rows(outcome.stdout);
		expect(row).toMatchObject({key: "7778", verdict: "working"});
		expect(row?.reason).toContain("#9257 is open and links #7778");
		expect(logOf(fs, "7778")).toBeUndefined();
	});

	it("never reads an unreadable claim as a dead one", async () => {
		const {outcome, fs} = await spawnSweep(building(), {
			_tag: "Unknown",
			reason: "the comment list could not be read",
		});
		expect(outcome.code).toBe(0);
		const [row] = rows(outcome.stdout);
		expect(row).toMatchObject({key: "7778", verdict: "unreadable"});
		expect(row?.reason).toContain("never read as dead");
		expect(logOf(fs, "7778")).toBeUndefined();
	});

	it("never reads an unsettled PR question as a dead builder", async () => {
		const {outcome, fs} = await spawnSweep(building(), dead(), undefined, false, {
			_tag: "Unknown",
			reason: "the pull request search could not be read",
		});
		expect(outcome.code).toBe(0);
		const [row] = rows(outcome.stdout);
		expect(row).toMatchObject({key: "7778", verdict: "unreadable"});
		expect(row?.reason).toContain("never read as dead");
		expect(logOf(fs, "7778")).toBeUndefined();
	});

	it("never reads several linking PRs as nothing published", async () => {
		const {outcome, fs} = await spawnSweep(building(), dead(), undefined, false, {
			_tag: "Read",
			trace: {_tag: "Many", prs: [9257, 9258]},
			scanned: 2,
		});
		expect(outcome.code).toBe(0);
		const [row] = rows(outcome.stdout);
		expect(row).toMatchObject({key: "7778", verdict: "unreadable"});
		expect(row?.reason).toContain("#9257, #9258 are open and link #7778");
		expect(logOf(fs, "7778")).toBeUndefined();
	});

	it("carries no event on a row that judged the lane to owe none", async () => {
		const {outcome} = await spawnSweep(building(), {
			_tag: "Alive",
			token: "build:live-session:9092",
			ageMinutes: 12,
			budgetMinutes: 40,
			scanned: 1,
		});
		const [row] = rows(outcome.stdout);
		expect(row).toMatchObject({verdict: "working"});
		expect(row).not.toHaveProperty("event");
	});

	it("reads a lane holding no claim at all as a dispatch, not a park", async () => {
		const {outcome, fs} = await spawnSweep(building(), {_tag: "Unclaimed", scanned: 0});
		expect(outcome.code).toBe(0);
		const [row] = rows(outcome.stdout);
		expect(row).toMatchObject({key: "7778", verdict: "working"});
		expect(row?.reason).toContain("no build claim stands on #7778");
		expect(logOf(fs, "7778")).toBeUndefined();
	});

	it("withholds the append under --check and still names where the park would land", async () => {
		const {outcome, fs} = await spawnSweep(building(), dead(), undefined, true);
		expect(outcome.code).toBe(0);
		const [row] = rows(outcome.stdout);
		expect(row).toMatchObject({
			key: "7778",
			verdict: "parkable",
			cause: "spawn-dead",
			from: BUILD_FOLD,
			to: BLOCKED_FOLD,
		});
		expect(logOf(fs, "7778")).toBeUndefined();
	});

	it("spends no board read on a building lane when the arm is off", async () => {
		const {outcome, asked, fs} = await sweep(building(), proven);
		expect(outcome.code).toBe(0);
		expect(rows(outcome.stdout)[0]).toMatchObject({key: "7778", verdict: "current"});
		expect(asked).toHaveLength(0);
		expect(logOf(fs, "7778")).toBeUndefined();
	});
});

describe("runRecover --spawns — the populations beside a single lane's plain build leaf", () => {
	it("parks a dead rendered-surface builder on a PR read it actually made", async () => {
		const ui = tree([{lane: "7778", log: BUILDING_LOG, workflow: uiTemplate()}]);
		const {outcome, asked, fs} = await spawnSweep(ui, dead());
		expect(outcome.code).toBe(0);
		const [row] = rows(outcome.stdout);
		expect(row).toMatchObject({
			key: "7778",
			verdict: "parked",
			state: "build:ui",
			event: "BLOCKED",
			cause: "spawn-dead",
			to: BLOCKED_FOLD,
		});
		// The read was made rather than skipped — the `build:ui` leaf used to fall off the recorded-
		// event claim table at `not-required` and land as an `unreadable` row naming a read nobody made.
		expect(asked).toEqual([7778]);
		expect(logOf(fs, "7778") ?? "").toContain("spawn-dead");
	});

	it("leaves a rendered-surface lane whose builder published a PR", async () => {
		const ui = tree([{lane: "7778", log: BUILDING_LOG, workflow: uiTemplate()}]);
		const {outcome, fs} = await spawnSweep(ui, dead(), undefined, false, {
			_tag: "Read",
			trace: {_tag: "One", pr: 9257},
			scanned: 1,
		});
		const [row] = rows(outcome.stdout);
		expect(row).toMatchObject({key: "7778", verdict: "working", state: "build:ui"});
		expect(row?.reason).toContain("#9257 is open and links #7778");
		expect(logOf(fs, "7778")).toBeUndefined();
	});

	it("parks an epic child on its branch read and spends no board read on a PR it cannot have", async () => {
		const child = tree([
			{lane: "9241", log: line("WIP", at(0), "issue_9301"), workflow: childTemplate()},
		]);
		const {outcome, claimed, asked, fs} = await spawnSweep(child, dead());
		expect(outcome.code).toBe(0);
		const parked = rows(outcome.stdout).find((row) => row.verdict === "parked");
		expect(parked).toMatchObject({
			key: "9241",
			task: "issue_9301",
			state: "build",
			event: "BLOCKED",
			cause: "spawn-dead",
		});
		// The child's own issue, never the epic's, and no PR read at all: a child opens none, so the
		// row must not claim one was inspected.
		expect(claimed).toEqual([9301]);
		expect(asked).toEqual([]);
		expect(parked?.reason).toContain("never onto a pull request");
		expect(logOf(fs, "9241") ?? "").toContain("spawn-dead");
	});

	it("leaves an epic child whose lane branch still carries its commits", async () => {
		const child = tree([
			{lane: "9241", log: line("WIP", at(0), "issue_9301"), workflow: childTemplate()},
		]);
		const {outcome, asked, fs} = await spawnSweep(child, dead(), {
			_tag: "Read",
			branches: ["build/9301-editor-focus-4f2a"],
		});
		const row = rows(outcome.stdout).find((entry) => entry.task === "issue_9301");
		expect(row).toMatchObject({verdict: "working"});
		expect(row?.reason).toContain("build/9301-editor-focus-4f2a");
		expect(asked).toEqual([]);
		expect(logOf(fs, "9241")).toBeUndefined();
	});
});
