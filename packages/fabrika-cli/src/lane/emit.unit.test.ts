/**
 * The pure epic-machine emitter: golden bytes off the committed fixture pair, determinism, the
 * compile/transition round trip, and every topology refusal as its own tagged arm.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {readGoldenFixture} from "../golden-fixture.ts";
import {classifyPark} from "../recipe/parks.ts";
import {CAP_ROUND, MACHINERY_LAP_BUDGET, RETRY_BUDGET} from "../retry-budget.ts";
import {WAIT_BUDGET} from "../wait-budget.ts";
import {type EmitResult, emitMachine} from "./emit.ts";
import {fakeProver, parkCauseRead} from "./fixtures.test-support.ts";
import {applyClearance, applyEvent, deriveStatus, foldLog, type LogEntry} from "./fold.ts";
import {type CompiledLane, compileText} from "./machine.ts";
import {declaresClosureGuard} from "./reconcile.ts";
import {routeForCause} from "./report.ts";
import {runTransition} from "./transition-verb.ts";

const body = (): string => readGoldenFixture(import.meta.url, "./__fixtures__/epic-4300.body.txt");
const golden = (): string =>
	readGoldenFixture(import.meta.url, "./__fixtures__/epic-4300.workflow.golden.txt");

const open = (number: number, classes: ReadonlyArray<string> = []) => ({
	number,
	state: "open" as const,
	stateReason: null,
	classes,
});
const closed = (number: number, stateReason: string | null = "completed") => ({
	number,
	state: "closed" as const,
	stateReason,
	classes: [],
});

const CHILDREN = [open(4301), open(4302), open(4303)];

const initialOf = (text: string, task: string): unknown => {
	const doc = JSON.parse(text) as {
		machine: {states: Record<string, {states: Record<string, {initial: string}>}>};
	};
	for (const phase of Object.values(doc.machine.states)) {
		const node = phase.states?.[task];
		if (node !== undefined) return node.initial;
	}
	throw new Error(`no region for ${task}`);
};

const emitted = (result: EmitResult): string => {
	if (result._tag !== "Emitted") throw new Error(`expected Emitted, got ${result._tag}`);
	return result.text;
};

const regionOf = (text: string, task: string): Record<string, unknown> => {
	const doc = JSON.parse(text) as {
		machine: {states: Record<string, {states?: Record<string, Record<string, unknown>>}>};
	};
	for (const phase of Object.values(doc.machine.states)) {
		const node = phase.states?.[task];
		if (node !== undefined) return node;
	}
	throw new Error(`no region for ${task}`);
};

const laneOf = (text: string): CompiledLane => {
	const compiled = compileText(text);
	if (compiled._tag !== "Compiled") throw new Error(compiled.defects.join("; "));
	return compiled.lane;
};

const AT = "2026-08-17T00:00:00.000Z";

const statesOf = (compiled: CompiledLane, entries: ReadonlyArray<LogEntry>) => {
	const fold = foldLog(compiled, entries);
	if (fold._tag !== "Folded") throw new Error(fold.defects.join("; "));
	return fold.states;
};

/** Drive a sequence through `applyEvent`, asserting every step is accepted, and keep the log. */
const driveLog = (
	compiled: CompiledLane,
	steps: ReadonlyArray<readonly [string, string]>,
	from: ReadonlyArray<LogEntry> = [],
): ReadonlyArray<LogEntry> => {
	const log: LogEntry[] = [...from];
	for (const [task, event] of steps) {
		const applied = applyEvent(compiled, statesOf(compiled, log), task, event, AT);
		if (applied._tag !== "Applied") throw new Error(`${task} ${event}: ${applied.reason}`);
		log.push(applied.entry);
	}
	return log;
};

const drive = (
	compiled: CompiledLane,
	steps: ReadonlyArray<readonly [string, string]>,
): ReturnType<typeof deriveStatus> =>
	deriveStatus(compiled, statesOf(compiled, driveLog(compiled, steps)));

/** Append one founder-cleared round the way `build clear` does — an event, never a context edit. */
const grant = (
	compiled: CompiledLane,
	log: ReadonlyArray<LogEntry>,
	task: string,
	round: number,
): ReadonlyArray<LogEntry> => {
	const applied = applyClearance(compiled, log, task, round, AT);
	if (applied._tag !== "Appendable") throw new Error(`grant ${round}: ${applied._tag}`);
	return [...log, applied.entry];
};

/** One child driven queued → build → review → integrate → landed. */
const land = (task: string): ReadonlyArray<readonly [string, string]> => [
	[task, "WIP"],
	[task, "DONE"],
	[task, "PASS"],
	[task, "DONE"],
];

/** Every child through its local loop to `landed`, in phase order. */
const LAND_ALL: ReadonlyArray<readonly [string, string]> = [
	...land("issue_4301"),
	...land("issue_4302"),
	...land("issue_4303"),
];

describe("emitMachine", () => {
	it("emits the golden machine bytes from the golden epic body", () => {
		expect(emitted(emitMachine(4300, body(), CHILDREN))).toBe(golden());
	});

	it("is deterministic — the same body bytes emit the same machine bytes", () => {
		const text = emitted(emitMachine(4300, body(), CHILDREN));
		expect(text).toBe(emitted(emitMachine(4300, body(), CHILDREN)));
		expect(text.match(/"integrate": \{/g)).toHaveLength(CHILDREN.length);
	});

	it("is deterministic over a partly-built epic too — the child states are input, not drift", () => {
		const links = [closed(4301), closed(4302, "not_planned"), open(4303)];
		expect(emitted(emitMachine(4300, body(), links))).toBe(
			emitted(emitMachine(4300, body(), links)),
		);
	});

	it("emits a machine the lane compiler accepts without repair", () => {
		const compiled = compileText(emitted(emitMachine(4300, body(), CHILDREN)));
		if (compiled._tag !== "Compiled") throw new Error(compiled.defects.join("; "));
		expect(compiled.lane.phases).toEqual([
			{name: "phase1", tasks: ["issue_4301", "issue_4302"]},
			{name: "phase2", tasks: ["issue_4303"]},
			{name: "epic", tasks: ["epic_4300"]},
		]);
		expect(compiled.lane.terminals).toEqual({complete: "complete", tripped: "tripped"});
	});

	it("emits a machine whose states and events `lane transition` accepts", async () => {
		const fs = fakeFs({
			files: {".fabrika/lanes/4300/workflow.json": emitted(emitMachine(4300, body(), CHILDREN))},
		});
		const out = await Effect.runPromise(
			Effect.provide(
				runTransition(
					{
						root: ".fabrika/lanes",
						lane: "4300",
						event: "WIP",
						task: "issue_4301",
						cause: null,
						parkCause: parkCauseRead(),
						classes: [],
						waitGrant: null,
						rationale: null,
						repo: "o/r",
						cwd: "/checkout",
						env: {},
					},
					fakeProver().prove,
				),
				fs.layer,
			),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			event: "ISSUE_4301.WIP",
			current: {phase1: {issue_4301: "build", issue_4302: "queued"}, phase2: "waiting"},
		});
	});

	it("emits an all-open epic byte-identically to the golden bytes — state widened nothing", () => {
		expect(emitted(emitMachine(4300, body(), [open(4301), open(4302), open(4303)]))).toBe(golden());
	});

	it("boots a completed-closed child in `landed` and leaves its open siblings queued", () => {
		const text = emitted(emitMachine(4300, body(), [closed(4301), open(4302), open(4303)]));
		expect(initialOf(text, "issue_4301")).toBe("landed");
		expect(initialOf(text, "issue_4302")).toBe("queued");
	});

	it("boots a child closed for any other reason in `frozen` — a close is never a landing", () => {
		const text = emitted(
			emitMachine(4300, body(), [closed(4301, "not_planned"), open(4302), open(4303)]),
		);
		expect(initialOf(text, "issue_4301")).toBe("frozen");
		const legacy = emitted(emitMachine(4300, body(), [closed(4301, null), open(4302), open(4303)]));
		expect(initialOf(legacy, "issue_4301")).toBe("frozen");
	});

	it("skips a fully-shipped phase at boot — its onDone fires with no human UNBLOCKED", async () => {
		const text = emitted(emitMachine(4300, body(), [closed(4301), closed(4302), open(4303)]));
		const fs = fakeFs({files: {".fabrika/lanes/4300/workflow.json": text}});
		const out = await Effect.runPromise(
			Effect.provide(
				runTransition(
					{
						root: ".fabrika/lanes",
						lane: "4300",
						event: "WIP",
						task: "issue_4303",
						cause: null,
						parkCause: parkCauseRead(),
						classes: [],
						waitGrant: null,
						rationale: null,
						repo: "o/r",
						cwd: "/checkout",
						env: {},
					},
					fakeProver().prove,
				),
				fs.layer,
			),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			event: "ISSUE_4303.WIP",
			previous: {phase2: {issue_4303: "queued"}},
			current: {phase2: {issue_4303: "build"}},
		});
	});

	it("gives a child no `ship` and no `human:cp-approval` — an epic run has one PR, not one per child", () => {
		const child = regionOf(emitted(emitMachine(4300, body(), CHILDREN)), "issue_4301") as {
			states: Record<string, unknown>;
		};
		expect(Object.keys(child.states)).toEqual([
			"queued",
			"build",
			"review",
			"integrate",
			"blocked",
			"human:replay-stall",
			"human:budget-spent",
			"hist",
			"landed",
			"frozen",
		]);
	});

	it("routes an integrate collision back into the local loop — no arm reaches a merge queue", () => {
		const child = regionOf(emitted(emitMachine(4300, body(), CHILDREN)), "issue_4301");
		expect(child).toMatchObject({
			states: {
				review: {on: {"ISSUE_4301.PASS": "integrate"}},
				integrate: {
					on: {
						"ISSUE_4301.DONE": "landed",
						"ISSUE_4301.WIP": [
							{target: "review", guard: "waitsRemaining", actions: "incrementWaits"},
							{target: "human:replay-stall"},
						],
						"ISSUE_4301.BLOCKED": "blocked",
						"ISSUE_4301.FAIL": [
							{target: "build", guard: "retriesRemaining", actions: "incrementRetries"},
							{target: "human:budget-spent"},
						],
					},
				},
			},
		});
	});

	it("sends a child's review PASS to integrate — the merge into the epic branch is its own state", () => {
		const compiled = laneOf(emitted(emitMachine(4300, body(), CHILDREN)));
		const status = drive(compiled, [
			["issue_4301", "WIP"],
			["issue_4301", "DONE"],
			["issue_4301", "PASS"],
		]);
		expect(status.stateValue).toEqual({
			phase1: {issue_4301: "integrate", issue_4302: "queued"},
			phase2: "waiting",
			epic: "waiting",
		});
	});

	it("lands a child on its integrate DONE — the success final asserts a landing, not a merge to main", () => {
		const compiled = laneOf(emitted(emitMachine(4300, body(), CHILDREN)));
		expect(drive(compiled, land("issue_4301")).stateValue).toEqual({
			phase1: {issue_4301: "landed", issue_4302: "queued"},
			phase2: "waiting",
			epic: "waiting",
		});
	});

	it("re-enters build on a collision at integrate, and re-proves the range through review before landing", () => {
		const compiled = laneOf(emitted(emitMachine(4300, body(), CHILDREN)));
		const collided: ReadonlyArray<readonly [string, string]> = [
			["issue_4301", "WIP"],
			["issue_4301", "DONE"],
			["issue_4301", "PASS"],
			["issue_4301", "FAIL"],
		];
		expect(drive(compiled, collided).stateValue).toMatchObject({
			phase1: {issue_4301: "build"},
		});
		expect(drive(compiled, [...collided, ["issue_4301", "DONE"]]).stateValue).toMatchObject({
			phase1: {issue_4301: "review"},
		});
		expect(
			drive(compiled, [
				...collided,
				["issue_4301", "DONE"],
				["issue_4301", "PASS"],
				["issue_4301", "DONE"],
			]).stateValue,
		).toMatchObject({phase1: {issue_4301: "landed"}});
	});

	it("sends a replayed range back through review on a WIP, and spends no retry doing it", () => {
		const compiled = laneOf(emitted(emitMachine(4300, body(), CHILDREN)));
		const replayed: ReadonlyArray<readonly [string, string]> = [
			["issue_4301", "WIP"],
			["issue_4301", "DONE"],
			["issue_4301", "PASS"],
			["issue_4301", "WIP"],
		];
		expect(drive(compiled, replayed).stateValue).toMatchObject({
			phase1: {issue_4301: "review"},
		});
		const spent = statesOf(compiled, driveLog(compiled, replayed)).issue_4301;
		expect(spent?.retries).toBe(0);
		expect(spent?.waits).toBe(1);
		expect(
			drive(compiled, [...replayed, ["issue_4301", "PASS"], ["issue_4301", "DONE"]]).stateValue,
		).toMatchObject({phase1: {issue_4301: "landed"}});
	});

	it("parks a child whose replay keeps re-colliding past its wait budget — the loop is bounded", () => {
		const compiled = laneOf(emitted(emitMachine(4300, body(), CHILDREN)));
		/** One replayed round: the moved range passes review, the next integrate replays it again. */
		const replay: ReadonlyArray<readonly [string, string]> = [
			["issue_4301", "WIP"],
			["issue_4301", "PASS"],
		];
		const spun: ReadonlyArray<readonly [string, string]> = [
			["issue_4301", "WIP"],
			["issue_4301", "DONE"],
			["issue_4301", "PASS"],
			...Array.from({length: WAIT_BUDGET}, () => replay).flat(),
			["issue_4301", "WIP"],
		];
		expect(drive(compiled, spun).stateValue).toMatchObject({
			phase1: {issue_4301: "human:replay-stall"},
		});
		const parked = statesOf(compiled, driveLog(compiled, spun)).issue_4301;
		expect(parked?.waits).toBe(WAIT_BUDGET);
		expect(parked?.retries).toBe(0);

		// The leaf is reached by a `WIP`, which may carry no `--cause`. Without a structural row it
		// would fold causeless, route to the founder and refuse `recipe unpark` forever — a machinery
		// failure spending a person, which is the dead end this region was rewritten to remove.
		expect(classifyPark("human:replay-stall", null)).toMatchObject({
			_tag: "Novel",
			cause: "replay-budget-spent",
		});
		expect(routeForCause("replay-budget-spent")).toBe("driver");
	});

	// A collided child used to exhaust into `frozen`, which `recipe/parks.ts` reads as no park at all
	// — so the run ended with a child no recipe could see and no PR for the one verb that grants a
	// round. The leaf is a driver-routed park now, and still the final it always was: the phase folds
	// and the lane trips loud, and the driver takes the next move off the cause.
	it("trips the lane on a driver-routed park when integrate keeps colliding past the budget", () => {
		const compiled = laneOf(emitted(emitMachine(4300, body(), CHILDREN)));
		/** One collided integration: the range passes review, the merge fails, the repair rebuilds. */
		const collide: ReadonlyArray<readonly [string, string]> = [
			["issue_4301", "PASS"],
			["issue_4301", "FAIL"],
			["issue_4301", "DONE"],
		];
		const exhausted: ReadonlyArray<readonly [string, string]> = [
			["issue_4301", "WIP"],
			["issue_4301", "DONE"],
			...Array.from({length: RETRY_BUDGET}, () => collide).flat(),
			["issue_4301", "PASS"],
			["issue_4301", "FAIL"],
		];
		expect(drive(compiled, exhausted).stateValue).toMatchObject({
			phase1: {issue_4301: "human:budget-spent"},
		});
		expect(classifyPark("human:budget-spent", null)).toMatchObject({
			_tag: "Novel",
			cause: "repair-budget-spent",
		});
		expect(routeForCause("repair-budget-spent")).toBe("driver");

		// The phase still folds behind the park, so the run ends loud rather than hanging: a landed
		// sibling carries the phase to its `onDone`, and the parked child is the error it trips on.
		const tripped = drive(compiled, [...exhausted, ...land("issue_4302")]);
		expect(tripped).toMatchObject({stateValue: "tripped", status: "done"});
		expect(tripped.context.errors).toEqual(["issue_4301"]);
	});

	it("carries an epic tail phase whose one region reviews the single PR, then ships it", () => {
		const tail = regionOf(emitted(emitMachine(4300, body(), CHILDREN)), "epic_4300");
		expect(tail).toMatchObject({
			initial: "review",
			states: {
				build: {on: {"EPIC_4300.DONE": "review", "EPIC_4300.BLOCKED": "blocked"}},
				review: {
					on: {
						"EPIC_4300.PASS": "ship",
						"EPIC_4300.FAIL": [
							{target: "build", guard: "retriesRemaining", actions: "incrementRetries"},
							{target: "human:budget-spent"},
						],
					},
				},
				ship: {
					on: {
						"EPIC_4300.DONE": "shipped",
						"EPIC_4300.BLOCKED": "human:cp-approval",
						"EPIC_4300.FAIL": [
							{target: "review", guard: "retriesRemaining", actions: "incrementRetries"},
							{target: "human:budget-spent"},
						],
					},
				},
				"ship:queued": {
					on: {
						"EPIC_4300.FAIL": [
							{target: "review", guard: "retriesRemaining", actions: "incrementRetries"},
							{target: "human:budget-spent"},
						],
					},
				},
				shipped: {type: "final"},
				"human:budget-spent": {type: "final", on: {"EPIC_4300.UNBLOCKED": "hist"}},
			},
		});
	});

	// Aimed back at `review`, the FAIL edge re-dispatched the reviewer that had just produced the
	// verdict over content only a builder can change.
	it("sends a tail review FAIL into the tail's own build cell, and the repair's DONE back to review", () => {
		const compiled = laneOf(emitted(emitMachine(4300, body(), CHILDREN)));
		expect(drive(compiled, [...LAND_ALL, ["epic_4300", "FAIL"]]).stateValue).toEqual({
			epic: {epic_4300: "build"},
		});
		expect(
			drive(compiled, [...LAND_ALL, ["epic_4300", "FAIL"], ["epic_4300", "DONE"]]).stateValue,
		).toEqual({epic: {epic_4300: "review"}});
		expect(
			drive(compiled, [...LAND_ALL, ["epic_4300", "FAIL"], ["epic_4300", "BLOCKED"]]).stateValue,
		).toEqual({epic: {epic_4300: "blocked"}});
	});

	it("reaches the epic review only after every child has landed, and completes on its ship", () => {
		const compiled = laneOf(emitted(emitMachine(4300, body(), CHILDREN)));
		expect(drive(compiled, LAND_ALL).stateValue).toEqual({epic: {epic_4300: "review"}});
		expect(
			drive(compiled, [...LAND_ALL, ["epic_4300", "PASS"], ["epic_4300", "DONE"]]),
		).toMatchObject({stateValue: "complete", status: "done"});
	});

	// The tail declares no `merge:partial` arm, and that is a decision rather than the
	// omission it looks like: a tail body that does not close its epic is refused where it is
	// written (`lane assembly-body`), so the merge such an arm would route is one the run cannot
	// produce. Both polarities are driven here so the absence stays deliberate under a later reader.
	it("folds the tail's DONE to `shipped` whether or not the merge carried `Part of #N`", () => {
		const compiled = laneOf(emitted(emitMachine(4300, body(), CHILDREN)));
		const toShip: ReadonlyArray<readonly [string, string]> = [...LAND_ALL, ["epic_4300", "PASS"]];

		expect(drive(compiled, [...toShip, ["epic_4300", "DONE"]])).toMatchObject({
			stateValue: "complete",
			status: "done",
		});

		const log = driveLog(compiled, toShip);
		const applied = applyEvent(
			compiled,
			statesOf(compiled, log),
			"epic_4300",
			"DONE",
			AT,
			null,
			null,
			true,
		);
		if (applied._tag !== "Applied") throw new Error(applied.reason);
		expect(deriveStatus(compiled, statesOf(compiled, [...log, applied.entry]))).toMatchObject({
			stateValue: "complete",
			status: "done",
		});
		expect(declaresClosureGuard(compiled)).toBe(false);
	});

	it("takes a FAIL at the epic ship back to review, and parks it once the retries are spent", () => {
		const compiled = laneOf(emitted(emitMachine(4300, body(), CHILDREN)));
		const toShip: ReadonlyArray<readonly [string, string]> = [...LAND_ALL, ["epic_4300", "PASS"]];
		expect(drive(compiled, [...toShip, ["epic_4300", "FAIL"]]).stateValue).toEqual({
			epic: {epic_4300: "review"},
		});

		const spent = drive(compiled, [
			...toShip,
			...Array.from({length: RETRY_BUDGET}, () => [
				["epic_4300", "FAIL"] as const,
				["epic_4300", "PASS"] as const,
			]).flat(),
			["epic_4300", "FAIL"],
		]);
		expect(spent).toMatchObject({stateValue: "tripped", status: "done"});
		expect(spent.context.errors).toEqual(["epic_4300"]);
	});

	it("trips the tail when the epic review fails past its retry budget — never `complete`", () => {
		const compiled = laneOf(emitted(emitMachine(4300, body(), CHILDREN)));
		const rounds = Array.from({length: RETRY_BUDGET}, () => [
			["epic_4300", "FAIL"] as const,
			["epic_4300", "DONE"] as const,
		]).flat();
		expect(drive(compiled, [...LAND_ALL, ...rounds]).stateValue).toEqual({
			epic: {epic_4300: "review"},
		});
		const spent = drive(compiled, [...LAND_ALL, ...rounds, ["epic_4300", "FAIL"]]);
		expect(spent).toMatchObject({stateValue: "tripped", status: "done"});
		expect(spent.context.errors).toEqual(["epic_4300"]);
	});

	// The no-door half of this fix is the leaf's NAME, not its finality: `frozen` matched no `isPark`,
	// so a spent tail parked where `recipe unpark` answered `NotParked`, and the only grant left was
	// `build clear` — PR-keyed, and an epic child opens none. `lane clear` is the seat that opens; the
	// budget guard on the door is unchanged, which is what this drives.
	it("walks the spent-budget park back into review on a granted round", () => {
		const compiled = laneOf(emitted(emitMachine(4300, body(), CHILDREN)));
		const parked = driveLog(compiled, [
			...LAND_ALL,
			...Array.from({length: CAP_ROUND - 1}, () => [
				["epic_4300", "FAIL"] as const,
				["epic_4300", "DONE"] as const,
			]).flat(),
			["epic_4300", "FAIL"],
		]);
		expect(deriveStatus(compiled, statesOf(compiled, parked))).toMatchObject({
			stateValue: "tripped",
			status: "done",
		});

		// The door is walkable and the budget still gates it, exactly as `frozen`'s did.
		expect(
			applyEvent(compiled, statesOf(compiled, parked), "epic_4300", "UNBLOCKED", AT),
		).toMatchObject({_tag: "Refused", kind: "unbudgeted-resume"});

		const resumed = driveLog(
			compiled,
			[["epic_4300", "UNBLOCKED"]],
			grant(compiled, parked, "epic_4300", CAP_ROUND),
		);
		expect(deriveStatus(compiled, statesOf(compiled, resumed))).toMatchObject({
			stateValue: {epic: {epic_4300: "review"}},
			status: "active",
		});
		expect(statesOf(compiled, resumed).epic_4300?.maxRetries).toBe(RETRY_BUDGET + 1);
	});

	it("terminates a partly-built epic — every child closed still leaves the epic review to run", () => {
		const compiled = laneOf(
			emitted(emitMachine(4300, body(), [closed(4301), closed(4302), closed(4303)])),
		);
		expect(drive(compiled, []).stateValue).toEqual({epic: {epic_4300: "review"}});
		expect(
			drive(compiled, [
				["epic_4300", "PASS"],
				["epic_4300", "DONE"],
			]),
		).toMatchObject({
			stateValue: "complete",
			status: "done",
		});
	});

	it("trips before the epic review when a child was closed without landing", () => {
		const compiled = laneOf(
			emitted(emitMachine(4300, body(), [closed(4301, "not_planned"), closed(4302), open(4303)])),
		);
		expect(drive(compiled, [])).toMatchObject({stateValue: "tripped", status: "done"});
	});

	it("leaves `coder.workflow.json` byte-untouched — a single-issue lane still ships its own PR", () => {
		const template = readGoldenFixture(import.meta.url, "./templates/coder.workflow.json");
		expect(template).toContain('"ISSUE.PASS": "ship"');
		expect(template).toContain('"ISSUE.BLOCKED": "human:cp-approval"');
		expect(template).not.toContain("landed");
		expect(template).not.toContain("integrate");
	});

	it("refuses a body with no ## Dependencies block", () => {
		expect(emitMachine(4300, "## Plan\n\nno topology here\n", CHILDREN)).toEqual({
			_tag: "NoTopology",
		});
	});

	it("refuses a block that parses to zero phase lines as no topology", () => {
		expect(emitMachine(4300, "## Dependencies\n\n", CHILDREN)).toEqual({_tag: "NoTopology"});
	});

	it("refuses a childless issue whose body carries prose under the topology heading", () => {
		const text = "## Dependencies\n\nNone blocking. PR #5899 merged, so this is buildable\n";
		expect(emitMachine(5908, text, [])).toEqual({_tag: "NoTopology"});
	});

	it("refuses a childless issue whose body carries a well-formed topology", () => {
		const text = "## Dependencies\n\n- phase 1: #4301\n";
		expect(emitMachine(4300, text, [])).toEqual({_tag: "NoTopology"});
	});

	it("still refuses an unparseable line once the epic has children", () => {
		const out = emitMachine(4300, "## Dependencies\n\n- phase one: #4301\n", CHILDREN);
		expect(out).toMatchObject({_tag: "Unparseable", line: 3, text: "- phase one: #4301"});
	});

	it("refuses a phase member that is not a child of the epic, naming it", () => {
		expect(emitMachine(4300, "## Dependencies\n\n- phase 1: #9999\n", CHILDREN)).toEqual({
			_tag: "Foreign",
			ref: "#9999",
		});
	});

	it("refuses a requires reference that is not a child of the epic", () => {
		const text = "## Dependencies\n\n- phase 1: #4301\n- #4301 requires: #9999\n";
		expect(emitMachine(4300, text, CHILDREN)).toEqual({_tag: "Foreign", ref: "#9999"});
	});

	it("refuses a ledger-local ref — an epic on the board holds only real issues", () => {
		expect(emitMachine(4300, "## Dependencies\n\n- phase 1: C1\n", CHILDREN)).toEqual({
			_tag: "Foreign",
			ref: "C1",
		});
	});

	it("refuses a cycle, naming the ref path", () => {
		const text =
			"## Dependencies\n\n- phase 1: #4301, #4302\n- #4301 requires: #4302\n- #4302 requires: #4301\n";
		const out = emitMachine(4300, text, CHILDREN);
		if (out._tag !== "Cycle") throw new Error(`expected Cycle, got ${out._tag}`);
		expect(out.path.length).toBeGreaterThan(2);
	});

	it("refuses a line under the heading that does not parse, naming it", () => {
		const out = emitMachine(4300, "## Dependencies\n\n- phase one: #4301\n", CHILDREN);
		expect(out).toMatchObject({_tag: "Unparseable", text: "- phase one: #4301"});
	});

	it("refuses a child placed in two phases", () => {
		const text = "## Dependencies\n\n- phase 1: #4301\n- phase 2: #4301\n";
		expect(emitMachine(4300, text, CHILDREN)).toEqual({_tag: "Duplicate", child: 4301});
	});

	it("refuses a requires subject placed in no phase", () => {
		const text = "## Dependencies\n\n- phase 1: #4301\n- #4303 requires: #4301\n";
		expect(emitMachine(4300, text, CHILDREN)).toEqual({_tag: "Unplaced", child: 4303});
	});
});

describe("emitMachine — the --children drop axis", () => {
	const drop = (text: string, links = CHILDREN): EmitResult =>
		emitMachine(4300, text, links, {dropForeign: true});

	const phasesOf = (text: string): Record<string, {states: Record<string, unknown>}> =>
		(JSON.parse(text) as {machine: {states: Record<string, {states: Record<string, unknown>}>}})
			.machine.states;

	it("takes the dropped ref out of its phase and out of every requires list naming it", () => {
		const text =
			"## Dependencies\n\n- phase 1: #4301\n- phase 2: #9999, #4302\n- #4302 requires: #4301, #9999\n- #9999 requires: #4301\n";
		const out = drop(text, [open(4301), open(4302)]);
		if (out._tag !== "Emitted") throw new Error(`expected Emitted, got ${out._tag}`);
		expect(out.dropped).toEqual(["#9999"]);
		expect(out.children).toBe(2);
		expect(out.text).not.toContain("9999");
		expect(Object.keys(phasesOf(out.text))).toEqual([
			"phase1",
			"phase2",
			"epic",
			"complete",
			"tripped",
		]);
	});

	it("elides a phase the drop left with no members, and keeps the surviving order", () => {
		const text = "## Dependencies\n\n- phase 1: #9999\n- phase 2: #4301\n- phase 3: #4302\n";
		const out = drop(text, [open(4301), open(4302)]);
		if (out._tag !== "Emitted") throw new Error(`expected Emitted, got ${out._tag}`);
		expect(out.phases).toBe(2);
		expect(Object.keys(phasesOf(out.text))).toEqual([
			"phase2",
			"phase3",
			"epic",
			"complete",
			"tripped",
		]);
		expect(JSON.parse(out.text)).toMatchObject({machine: {initial: "phase2"}});
	});

	it("records a ref that appears only in the needs of a requires line whose subject went", () => {
		const text =
			"## Dependencies\n\n- phase 1: #4301\n- phase 2: #9998\n- #9998 requires: #4301, #9999\n";
		const out = drop(text, [open(4301)]);
		if (out._tag !== "Emitted") throw new Error(`expected Emitted, got ${out._tag}`);
		expect(out.dropped).toEqual(["#9998", "#9999"]);
		expect(out.children).toBe(1);
	});

	it("drops a ledger-local ref too — it is in no child list either", () => {
		const out = drop("## Dependencies\n\n- phase 1: C1, #4301\n", [open(4301)]);
		if (out._tag !== "Emitted") throw new Error(`expected Emitted, got ${out._tag}`);
		expect(out.dropped).toEqual(["C1"]);
	});

	it("reports nothing dropped when every ref is a live child", () => {
		const out = drop(body());
		if (out._tag !== "Emitted") throw new Error(`expected Emitted, got ${out._tag}`);
		expect(out.dropped).toEqual([]);
		expect(out.text).toBe(golden());
	});

	it("refuses an emission the drop emptied, naming what went", () => {
		const out = drop("## Dependencies\n\n- phase 1: #9998, #9999\n");
		expect(out).toEqual({_tag: "Emptied", dropped: ["#9998", "#9999"]});
	});

	it("still refuses every other topology defect over what survives the drop", () => {
		expect(drop("## Dependencies\n\n- phase one: #4301\n")).toMatchObject({
			_tag: "Unparseable",
		});
		expect(drop("## Dependencies\n\n- phase 1: #4301\n- phase 2: #4301, #9999\n")).toEqual({
			_tag: "Duplicate",
			child: 4301,
		});
		expect(drop("## Dependencies\n\n- phase 1: #4301\n- #4303 requires: #4301, #9999\n")).toEqual({
			_tag: "Unplaced",
			child: 4303,
		});
		const cyclic =
			"## Dependencies\n\n- phase 1: #4301, #4302, #9999\n- #4301 requires: #4302, #9999\n- #4302 requires: #4301\n";
		expect(drop(cyclic)).toMatchObject({_tag: "Cycle"});
	});

	it("leaves the 16 refusal exactly where it was without the flag", () => {
		const text = "## Dependencies\n\n- phase 1: #4301\n- phase 2: #9999\n";
		expect(emitMachine(4300, text, CHILDREN)).toEqual({_tag: "Foreign", ref: "#9999"});
	});
});

describe("emitMachine — the machinery lap axis", () => {
	const withLaps = (): string => emitted(emitMachine(4300, body(), CHILDREN, {machinery: true}));

	const lapStatesOf = (lane: CompiledLane, task: string): number => {
		const compiled = lane.tasks[task];
		if (compiled === undefined) throw new Error(`no task ${task}`);
		return compiled.lapStates.size;
	};

	it("emits today's machine byte for byte with the axis off", () => {
		expect(emitted(emitMachine(4300, body(), CHILDREN, {machinery: false}))).toBe(golden());
		expect(emitted(emitMachine(4300, body(), CHILDREN))).toBe(golden());
	});

	it("seeds every task's lap counter with the axis on, and none with it off", () => {
		const contextOf = (text: string): Record<string, Record<string, unknown>> =>
			(JSON.parse(text) as {machine: {context: Record<string, Record<string, unknown>>}}).machine
				.context;

		for (const seeded of Object.values(contextOf(withLaps()))) {
			expect(seeded).toEqual({
				retries: 0,
				maxRetries: RETRY_BUDGET,
				laps: 0,
				maxLaps: MACHINERY_LAP_BUDGET,
			});
		}
		for (const seeded of Object.values(contextOf(golden()))) {
			expect(seeded).toEqual({retries: 0, maxRetries: RETRY_BUDGET});
		}
	});

	it("spends a lap and no retry on a collision reported as machinery", () => {
		const compiled = laneOf(withLaps());
		const collided: ReadonlyArray<readonly [string, string]> = [
			["issue_4301", "WIP"],
			["issue_4301", "DONE"],
			["issue_4301", "PASS"],
			["issue_4301", "LAP"],
		];

		expect(drive(compiled, collided).stateValue).toMatchObject({
			phase1: {issue_4301: "review"},
		});
		const spent = statesOf(compiled, driveLog(compiled, collided)).issue_4301;
		expect(spent?.retries).toBe(0);
		expect(spent?.laps).toBe(1);
	});

	it("spends a retry and no lap on the same collision reported as the child's own FAIL", () => {
		const compiled = laneOf(withLaps());
		const failed: ReadonlyArray<readonly [string, string]> = [
			["issue_4301", "WIP"],
			["issue_4301", "DONE"],
			["issue_4301", "PASS"],
			["issue_4301", "FAIL"],
		];

		expect(drive(compiled, failed).stateValue).toMatchObject({phase1: {issue_4301: "build"}});
		const spent = statesOf(compiled, driveLog(compiled, failed)).issue_4301;
		expect(spent?.retries).toBe(1);
		expect(spent?.laps).toBe(0);
	});

	it("parks a child whose machinery keeps failing past its lap budget, rather than freezing it", () => {
		const compiled = laneOf(withLaps());
		/** One machinery round: the lap sends the range back to review, review passes it on again. */
		const lap: ReadonlyArray<readonly [string, string]> = [
			["issue_4301", "LAP"],
			["issue_4301", "PASS"],
		];
		const spun: ReadonlyArray<readonly [string, string]> = [
			["issue_4301", "WIP"],
			["issue_4301", "DONE"],
			["issue_4301", "PASS"],
			...Array.from({length: MACHINERY_LAP_BUDGET}, () => lap).flat(),
			["issue_4301", "LAP"],
		];

		expect(drive(compiled, spun).stateValue).toMatchObject({
			phase1: {issue_4301: "human:machinery-stall"},
		});
		const parked = statesOf(compiled, driveLog(compiled, spun)).issue_4301;
		expect(parked?.laps).toBe(MACHINERY_LAP_BUDGET);
		expect(parked?.retries).toBe(0);
		expect(drive(compiled, spun).status).toBe("active");
	});

	it("takes the epic tail's machinery lap back to ship, leaving the epic review's retries whole", () => {
		const compiled = laneOf(withLaps());
		const toShip: ReadonlyArray<readonly [string, string]> = [
			...CHILDREN.flatMap(
				(child) =>
					[
						[`issue_${child.number}`, "WIP"],
						[`issue_${child.number}`, "DONE"],
						[`issue_${child.number}`, "PASS"],
						[`issue_${child.number}`, "DONE"],
					] as ReadonlyArray<readonly [string, string]>,
			),
			["epic_4300", "PASS"],
			["epic_4300", "LAP"],
		];

		expect(drive(compiled, toShip).stateValue).toMatchObject({epic: {epic_4300: "ship"}});
		const spent = statesOf(compiled, driveLog(compiled, toShip)).epic_4300;
		expect(spent?.retries).toBe(0);
		expect(spent?.laps).toBe(1);
	});

	it("folds a machine emitted before the axis existed exactly as it always did", () => {
		const before = laneOf(golden());
		const after = laneOf(withLaps());
		const walked: ReadonlyArray<readonly [string, string]> = [
			["issue_4301", "WIP"],
			["issue_4301", "DONE"],
			["issue_4301", "PASS"],
			["issue_4301", "FAIL"],
		];

		expect(drive(before, walked).stateValue).toEqual(drive(after, walked).stateValue);
		expect(statesOf(before, driveLog(before, walked)).issue_4301).toMatchObject({
			retries: 1,
			laps: 0,
		});
		// The pre-axis machine holds no lap-guarded cell at all, so nothing can spend the counter and
		// its status carries none to read — the whole containment, in two assertions.
		expect(lapStatesOf(before, "issue_4301")).toBe(0);
		expect(lapStatesOf(after, "issue_4301")).toBe(1);
	});
});

/**
 * The class axis: an unclassed emission is the bytes it always was, and a `ui` child carries the
 * seed AND the guarded arm into `build:ui`. Without the arm the seed reaches an emitted child and
 * turns nothing — the half of the ui-lane wiring a folded report named from the other end.
 *
 * The rendered REVIEW cell is asserted absent, because the decision record on a child's rendered
 * review rules it the epic tail's: a `review:ui` cell a child entered dispatches a gate over a range
 * with no pull request and proves nothing.
 */
describe("emitMachine — the class axis", () => {
	const classedChildren = [open(4301, ["ui"]), open(4302), open(4303)];
	const classedText = (): string => emitted(emitMachine(4300, body(), classedChildren));

	it("leaves every byte alone when no child carries a class", () => {
		expect(emitted(emitMachine(4300, body(), CHILDREN))).toBe(golden());
	});

	it("seeds the classed child's context entry, and only that child's", () => {
		const document = JSON.parse(classedText()) as {
			machine: {context: Record<string, Record<string, unknown>>};
		};
		expect(document.machine.context.issue_4301).toMatchObject({classes: ["ui"]});
		expect(document.machine.context.issue_4302).not.toHaveProperty("classes");
		expect(document.machine.context.epic_4300).not.toHaveProperty("classes");
	});

	it("gives the classed child build:ui and NO review:ui, and no sibling either", () => {
		const classed = regionOf(classedText(), "issue_4301") as {
			states: Record<string, unknown>;
		};
		const plain = regionOf(classedText(), "issue_4302") as {states: Record<string, unknown>};

		expect(Object.keys(classed.states)).toContain("build:ui");
		expect(Object.keys(classed.states)).not.toContain("review:ui");
		expect(Object.keys(plain.states)).not.toContain("build:ui");
	});

	it("leaves the classed child's review PASS a plain target into integrate", () => {
		const classed = regionOf(classedText(), "issue_4301") as {
			states: Record<string, {on: Record<string, unknown>}>;
		};

		expect(classed.states.review?.on["ISSUE_4301.PASS"]).toBe("integrate");
	});

	it("routes the classed child's FIRST WIP to build:ui, and its PASS straight to integrate", () => {
		const lane = laneOf(classedText());
		const log = driveLog(lane, [
			["issue_4301", "WIP"],
			["issue_4301", "DONE"],
			["issue_4301", "PASS"],
		]);

		expect(lane.tasks.issue_4301?.initial.classes).toEqual(["ui"]);
		expect(statesOf(lane, log.slice(0, 1)).issue_4301?.type).toBe("build:ui");
		expect(statesOf(lane, log).issue_4301?.type).toBe("integrate");
	});

	it("still lands the classed child through integrate — the ui arm adds a shell, not a leg", () => {
		const lane = laneOf(classedText());
		const log = driveLog(lane, [
			["issue_4301", "WIP"],
			["issue_4301", "DONE"],
			["issue_4301", "PASS"],
			["issue_4301", "DONE"],
		]);

		expect(statesOf(lane, log).issue_4301?.type).toBe("landed");
	});
});
