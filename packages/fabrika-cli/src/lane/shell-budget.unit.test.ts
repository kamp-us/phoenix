import {describe, expect, it} from "vitest";
import {readGoldenFixture} from "../golden-fixture.ts";
import {SHELL_STATES, shellOf} from "../wire/lane-brief.ts";
import {emitMachine} from "./emit.ts";
import {coderWorkflow} from "./fixtures.test-support.ts";
import {eventForToken} from "./report.ts";
import {
	BUILD_CLAIM_BUDGET_MINUTES,
	budgetMinutesFor,
	DISPATCH_BUDGET,
	livenessOf,
	SHELL_BUDGETS,
} from "./shell-budget.ts";

describe("the horizon is derived from the work, and cannot go back to a fixed literal", () => {
	// The defect this table replaced: one number for the pipeline. A revision that collapses the rows
	// back to a single value reads as a fixed horizon however many rows it is written across, so the
	// distinctness is what the test binds — not the numbers, which the weekly machinery review tunes.
	it("does not give every shell the same horizon", () => {
		const minutes = new Set(SHELL_STATES.map((state) => SHELL_BUDGETS[state].minutes));
		expect(minutes.size).toBeGreaterThan(1);
	});

	// The shape of the work fixes the ordering even when tuning moves the numbers: a builder loops,
	// a reviewer reads once, a shipper walks a fixed chain and hands the wait off.
	it("orders the horizons by the shape of each shell's work", () => {
		expect(SHELL_BUDGETS.build.minutes).toBeGreaterThan(SHELL_BUDGETS.review.minutes);
		expect(SHELL_BUDGETS.review.minutes).toBeGreaterThan(SHELL_BUDGETS.ship.minutes);
	});

	it("carries a budget for every state that routes to a shell", () => {
		for (const state of SHELL_STATES) {
			expect(shellOf(state)).toBeTypeOf("string");
			expect(SHELL_BUDGETS[state].minutes).toBeGreaterThan(0);
		}
	});

	// A number with no recorded reason is a bare literal wearing a table's clothes.
	it("records the derivation beside every number", () => {
		for (const state of SHELL_STATES) {
			expect(SHELL_BUDGETS[state].why.trim().length).toBeGreaterThan(0);
		}
		expect(DISPATCH_BUDGET.why.trim().length).toBeGreaterThan(0);
	});

	it("judges a build claim against the builder's own budget", () => {
		expect(BUILD_CLAIM_BUDGET_MINUTES).toBe(SHELL_BUDGETS.build.minutes);
	});
});

describe("budgetMinutesFor", () => {
	it("takes the longest budget among the leaves that route to a shell", () => {
		expect(budgetMinutesFor(["ship", "build"])).toBe(SHELL_BUDGETS.build.minutes);
		expect(budgetMinutesFor(["review", "ship"])).toBe(SHELL_BUDGETS.review.minutes);
	});

	it("falls to the dispatch budget when nothing is driving", () => {
		expect(budgetMinutesFor(["queued"])).toBe(DISPATCH_BUDGET.minutes);
		expect(budgetMinutesFor([])).toBe(DISPATCH_BUDGET.minutes);
	});
});

describe("livenessOf", () => {
	const at = (iso: string): number => Date.parse(iso);

	it("is Dead once the age reaches the budget", () => {
		expect(
			livenessOf("2026-09-09T00:00:00.000Z", at("2026-09-09T00:40:00.000Z"), 40),
		).toMatchObject({_tag: "Dead", ageMinutes: 40, budgetMinutes: 40});
	});

	it("is Live one minute short of it", () => {
		expect(
			livenessOf("2026-09-09T00:00:00.000Z", at("2026-09-09T00:39:00.000Z"), 40),
		).toMatchObject({_tag: "Live", ageMinutes: 39});
	});

	// A clock that ran backwards floors at zero and reads Live: waiting costs a lap, a wrong eviction
	// costs a live shell's work.
	it("is Live when the clock ran backwards", () => {
		expect(
			livenessOf("2026-09-09T01:00:00.000Z", at("2026-09-09T00:00:00.000Z"), 40),
		).toMatchObject({_tag: "Live", ageMinutes: 0});
	});

	it("is Unreadable on an instant that does not parse — never Dead, never Live", () => {
		expect(livenessOf("whenever", at("2026-09-09T00:00:00.000Z"), 40)._tag).toBe("Unreadable");
	});
});

interface CoderShape {
	readonly machine: {
		readonly states: {
			readonly pipeline: {
				readonly states: {
					readonly issue: {
						readonly states: Record<string, {readonly on?: Record<string, unknown>}>;
					};
				};
			};
		};
	};
}

// A budget that flags a dead shell is worth nothing if the death has no route onto the ledger, and
// the two used to disagree: `SHELL-DEAD` mapped to the machine's `LAP` while three budgeted states
// carried no `ISSUE.LAP` edge, so a dead reviewer was refused at exit 12 with the log unappended.
describe("every budgeted state can record the death its budget detects", () => {
	const lapCell = (state: string): unknown =>
		(coderWorkflow() as CoderShape).machine.states.pipeline.states.issue.states[state]?.on?.[
			"ISSUE.LAP"
		];

	it("maps SHELL-DEAD to the machine's LAP", () => {
		expect(eventForToken("SHELL-DEAD")).toMatchObject({_tag: "Mapped", event: "LAP"});
	});

	it("gives the coder machine an ISSUE.LAP edge in every state that carries a budget", () => {
		for (const state of SHELL_STATES) {
			expect(lapCell(state), `${state} has a budget and no ISSUE.LAP edge`).toBeDefined();
		}
	});
});

// The coder fixture is one of two machines a lane can run, and asserting the invariant over it alone
// is what let the generated epic machine ship with three budgeted states blind: a builder or a
// reviewer killed on an epic child, and a reviewer killed on the epic tail, had no route onto the
// ledger at all. The emitter is the subject here, so the assertion walks what it emits rather than
// a committed file.
describe("every budgeted state of the GENERATED epic machine can record the same death", () => {
	const EPIC = 4300;
	const CHILD = 4301;
	const body = (): string =>
		readGoldenFixture(import.meta.url, "./__fixtures__/epic-4300.body.txt");

	const open = (number: number, classes: ReadonlyArray<string> = []) => ({
		number,
		state: "open" as const,
		stateReason: null,
		classes,
	});

	/** Every region of one emission, keyed by task id. */
	const regionsOf = (machinery: boolean, classes: ReadonlyArray<string> = []) => {
		const result = emitMachine(EPIC, body(), [open(CHILD, classes), open(4302), open(4303)], {
			machinery,
		});
		if (result._tag !== "Emitted") throw new Error(`expected Emitted, got ${result._tag}`);
		const document = JSON.parse(result.text) as {
			machine: {
				states: Record<
					string,
					{states?: Record<string, {states: Record<string, {on?: Record<string, unknown>}>}>}
				>;
			};
		};
		return Object.values(document.machine.states).flatMap((phase) =>
			Object.entries(phase.states ?? {}).map(([task, region]) => ({task, states: region.states})),
		);
	};

	/** `<TASK>` uppercased is the namespace every arm in that region is keyed under. */
	const lapKey = (task: string): string => `${task.toUpperCase()}.LAP`;

	const shellCells = (machinery: boolean, classes: ReadonlyArray<string> = []) =>
		regionsOf(machinery, classes).flatMap(({task, states}) =>
			SHELL_STATES.filter((state) => states[state] !== undefined).map((state) => ({
				where: `${task}.${state}`,
				lap: states[state]?.on?.[lapKey(task)],
			})),
		);

	it("reaches a child's build and review and the tail's, not only the cells that already had one", () => {
		expect(
			shellCells(true)
				.map((cell) => cell.where)
				.sort(),
		).toEqual([
			"epic_4300.build",
			"epic_4300.review",
			"epic_4300.review:ui",
			"epic_4300.ship",
			"issue_4301.build",
			"issue_4301.review",
			"issue_4302.build",
			"issue_4302.review",
			"issue_4303.build",
			"issue_4303.review",
		]);
	});

	it("gives every budgeted state a LAP arm with the axis on", () => {
		for (const cell of shellCells(true)) {
			expect(cell.lap, `${cell.where} has a budget and no LAP arm`).toBeDefined();
		}
	});

	it("gives a rendered child's build:ui one too", () => {
		const rendered = shellCells(true, ["ui"]).filter(
			(cell) => cell.where === "issue_4301.build:ui",
		);
		expect(rendered).toHaveLength(1);
		expect(rendered[0]?.lap).toBeDefined();
	});

	it("gives none of them a LAP arm with the axis off", () => {
		for (const cell of [...shellCells(false), ...shellCells(false, ["ui"])]) {
			expect(
				cell.lap,
				`${cell.where} carries a LAP arm the axis was meant to gate`,
			).toBeUndefined();
		}
	});
});
