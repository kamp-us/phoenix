/**
 * The drift guard on the two declared budgets — the repair one, and the machinery lap one beside it.
 *
 * `lane/templates/coder.workflow.json` is JSON and cannot import {@link RETRY_BUDGET}, so an edit to
 * the template is exactly how the number quietly grew a second value before. These assertions read
 * the committed bytes and the emitter's output back against the constant, so that edit reds here.
 * {@link MACHINERY_LAP_BUDGET} is held the same way and for the same reason.
 */
import {describe, expect, it} from "vitest";
import {readGoldenFixture} from "./golden-fixture.ts";
import {emitMachine} from "./lane/emit.ts";
import {coderTemplateText} from "./lane/fixtures.test-support.ts";
import {applyEvent, foldLog, type LogEntry} from "./lane/fold.ts";
import {compileText} from "./lane/machine.ts";
import {causeForEvent, routeForCause} from "./lane/report.ts";
import {classifyPark} from "./recipe/parks.ts";
import {CAP_ROUND, MACHINERY_LAP_BUDGET, RETRY_BUDGET} from "./retry-budget.ts";

const AT = "2026-09-10T00:00:00.000Z";

const EPIC = 4300;
const CHILDREN = [4301, 4302, 4303].map((number) => ({
	number,
	state: "open" as const,
	stateReason: null,
}));

const epicBody = (): string =>
	readGoldenFixture(import.meta.url, "./lane/__fixtures__/epic-4300.body.txt");

const compiledInitials = (text: string): ReadonlyArray<number> => {
	const compiled = compileText(text);
	if (compiled._tag !== "Compiled") throw new Error(compiled.defects.join("; "));
	return Object.values(compiled.lane.tasks).map((task) => task.initial.maxRetries);
};

const compiledLapBudgets = (text: string): ReadonlyArray<number> => {
	const compiled = compileText(text);
	if (compiled._tag !== "Compiled") throw new Error(compiled.defects.join("; "));
	return Object.values(compiled.lane.tasks).map((task) => task.initial.maxLaps);
};

describe("the one retry budget", () => {
	it("is what the committed coder template carries into its compiled task", () => {
		expect(compiledInitials(coderTemplateText())).toEqual([RETRY_BUDGET]);
	});

	it("is what an emitted epic machine carries into every task — each child, and the epic tail", () => {
		const emitted = emitMachine(EPIC, epicBody(), CHILDREN);
		if (emitted._tag !== "Emitted") throw new Error(`expected Emitted, got ${emitted._tag}`);

		expect(compiledInitials(emitted.text)).toEqual(
			[...CHILDREN, "epic tail"].map(() => RETRY_BUDGET),
		);
	});

	it("is not the lap budget — the two axes are separate numbers", () => {
		expect(MACHINERY_LAP_BUDGET).not.toBe(RETRY_BUDGET);
	});

	it("is the default a task context that declares no budget of its own compiles to", () => {
		const noBudget = JSON.parse(coderTemplateText()) as {
			machine: {context: Record<string, unknown>};
		};
		noBudget.machine.context.issue = {retries: 0};

		expect(compiledInitials(JSON.stringify(noBudget))).toEqual([RETRY_BUDGET]);
	});

	it("is one more than nothing and one less than the round that spends it", () => {
		expect(CAP_ROUND).toBe(RETRY_BUDGET + 1);
	});

	// A lane emitted before the raise seeded its own number into `machine.context`, and the compiler
	// reads the declaration over the constant — so raising the constant moves no lane already on disk.
	it("is not what a lane emitted under the old budget folds under", () => {
		const older = JSON.parse(coderTemplateText()) as {
			machine: {context: {issue: Record<string, unknown>}};
		};
		older.machine.context.issue = {...older.machine.context.issue, maxRetries: RETRY_BUDGET - 1};
		const text = JSON.stringify(older);

		expect(compiledInitials(text)).toEqual([RETRY_BUDGET - 1]);

		const compiled = compileText(text);
		if (compiled._tag !== "Compiled") throw new Error(compiled.defects.join("; "));
		const spent = ["WIP", ...Array.from({length: RETRY_BUDGET}, () => ["DONE", "FAIL"]).flat()];
		const log: LogEntry[] = [];
		for (const event of spent) {
			const fold = foldLog(compiled.lane, log);
			if (fold._tag !== "Folded") throw new Error(fold.defects.join("; "));
			const applied = applyEvent(compiled.lane, fold.states, "issue", event, AT);
			if (applied._tag !== "Applied") throw new Error(`${event}: ${applied.reason}`);
			log.push(applied.entry);
		}
		const fold = foldLog(compiled.lane, log);
		if (fold._tag !== "Folded") throw new Error(fold.defects.join("; "));
		// One round short of today's budget, and already parked: the older lane kept its own number.
		expect(fold.states.issue).toMatchObject({
			type: "human:budget-spent",
			retries: RETRY_BUDGET - 1,
			maxRetries: RETRY_BUDGET - 1,
		});
	});
});

describe("the spent-budget park", () => {
	it("carries its cause off the leaf, since no FAIL may name one, and routes to the driver", () => {
		expect(causeForEvent("repair-budget-spent", "FAIL", false)._tag).toBe("Rejected");
		expect(classifyPark("human:budget-spent", null)).toMatchObject({
			_tag: "Novel",
			cause: "repair-budget-spent",
		});
		expect(routeForCause("repair-budget-spent")).toBe("driver");
	});

	it("still yields to a cause the recorder named, the way a machinery lap does", () => {
		expect(classifyPark("human:budget-spent", "replay-conflict")).toMatchObject({
			_tag: "Novel",
			cause: "replay-conflict",
		});
	});
});

describe("the one machinery lap budget", () => {
	it("is what the committed coder template carries into its compiled task", () => {
		expect(compiledLapBudgets(coderTemplateText())).toEqual([MACHINERY_LAP_BUDGET]);
	});

	it("is what an epic machine emitted with the axis on carries into every task", () => {
		const emitted = emitMachine(EPIC, epicBody(), CHILDREN, true);
		if (emitted._tag !== "Emitted") throw new Error(`expected Emitted, got ${emitted._tag}`);

		expect(compiledLapBudgets(emitted.text)).toEqual(
			[...CHILDREN, "epic tail"].map(() => MACHINERY_LAP_BUDGET),
		);
	});

	it("is the default a task context that declares no lap budget of its own compiles to", () => {
		const noBudget = JSON.parse(coderTemplateText()) as {
			machine: {context: Record<string, unknown>};
		};
		noBudget.machine.context.issue = {retries: 0};

		expect(compiledLapBudgets(JSON.stringify(noBudget))).toEqual([MACHINERY_LAP_BUDGET]);
	});
});
