/**
 * The pure epic-machine emitter: golden bytes off the committed fixture pair, determinism, the
 * compile/transition round trip, and every topology refusal as its own tagged arm.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {readGoldenFixture} from "../golden-fixture.ts";
import {RETRY_BUDGET} from "../retry-budget.ts";
import {type EmitResult, emitMachine} from "./emit.ts";
import {applyEvent, deriveStatus, foldLog, type LogEntry} from "./fold.ts";
import {type CompiledLane, compileText} from "./machine.ts";
import {runTransition} from "./transition-verb.ts";

const body = (): string => readGoldenFixture(import.meta.url, "./__fixtures__/epic-4300.body.txt");
const golden = (): string =>
	readGoldenFixture(import.meta.url, "./__fixtures__/epic-4300.workflow.golden.txt");

const open = (number: number) => ({number, state: "open" as const, stateReason: null});
const closed = (number: number, stateReason: string | null = "completed") => ({
	number,
	state: "closed" as const,
	stateReason,
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

/** Drive a sequence through `applyEvent`, asserting every step is accepted, and fold the result. */
const drive = (
	compiled: CompiledLane,
	steps: ReadonlyArray<readonly [string, string]>,
): ReturnType<typeof deriveStatus> => {
	const log: LogEntry[] = [];
	const statesOf = (entries: ReadonlyArray<LogEntry>) => {
		const fold = foldLog(compiled, entries);
		if (fold._tag !== "Folded") throw new Error(fold.defects.join("; "));
		return fold.states;
	};
	for (const [task, event] of steps) {
		const applied = applyEvent(compiled, statesOf(log), task, event, "2026-08-17T00:00:00.000Z");
		if (applied._tag !== "Applied") throw new Error(`${task} ${event}: ${applied.reason}`);
		log.push(applied.entry);
	}
	return deriveStatus(compiled, statesOf(log));
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
				runTransition({root: ".fabrika/lanes", lane: "4300", event: "WIP", task: "issue_4301"}),
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
				runTransition({root: ".fabrika/lanes", lane: "4300", event: "WIP", task: "issue_4303"}),
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
						"ISSUE_4301.BLOCKED": "blocked",
						"ISSUE_4301.FAIL": [
							{target: "build", guard: "retriesRemaining", actions: "incrementRetries"},
							{target: "frozen"},
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

	it("trips the lane when integrate keeps colliding past the retry budget — never a landing", () => {
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
			phase1: {issue_4301: "frozen"},
		});
		const tripped = drive(compiled, [...exhausted, ...land("issue_4302")]);
		expect(tripped).toMatchObject({stateValue: "tripped", status: "done"});
		expect(tripped.context.errors).toEqual(["issue_4301"]);
	});

	it("carries an epic tail phase whose one region reviews the single PR, then ships it", () => {
		const tail = regionOf(emitted(emitMachine(4300, body(), CHILDREN)), "epic_4300");
		expect(tail).toMatchObject({
			initial: "review",
			states: {
				review: {
					on: {
						"EPIC_4300.PASS": "ship",
						"EPIC_4300.FAIL": [
							{target: "review", guard: "retriesRemaining", actions: "incrementRetries"},
							{target: "human:epic-review"},
						],
					},
				},
				ship: {on: {"EPIC_4300.DONE": "shipped", "EPIC_4300.BLOCKED": "human:cp-approval"}},
				shipped: {type: "final"},
				"human:epic-review": {type: "final"},
			},
		});
	});

	it("reaches the epic review only after every child has landed, and completes on its ship", () => {
		const compiled = laneOf(emitted(emitMachine(4300, body(), CHILDREN)));
		expect(drive(compiled, LAND_ALL).stateValue).toEqual({epic: {epic_4300: "review"}});
		expect(
			drive(compiled, [...LAND_ALL, ["epic_4300", "PASS"], ["epic_4300", "DONE"]]),
		).toMatchObject({stateValue: "complete", status: "done"});
	});

	it("trips the lane when the epic review fails past its retry budget — a park, never `complete`", () => {
		const compiled = laneOf(emitted(emitMachine(4300, body(), CHILDREN)));
		const fails: ReadonlyArray<readonly [string, string]> = [
			["epic_4300", "FAIL"],
			["epic_4300", "FAIL"],
		];
		expect(drive(compiled, [...LAND_ALL, ...fails]).stateValue).toEqual({
			epic: {epic_4300: "review"},
		});
		const spent = drive(compiled, [...LAND_ALL, ...fails, ["epic_4300", "FAIL"]]);
		expect(spent).toMatchObject({stateValue: "tripped", status: "done"});
		expect(spent.context.errors).toEqual(["epic_4300"]);
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
