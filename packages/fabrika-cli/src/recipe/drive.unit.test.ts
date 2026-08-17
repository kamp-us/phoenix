import {describe, expect, it} from "vitest";
import {choreWorkflow} from "../lane/fixtures.test-support.ts";
import {compile, isOperatorEvent} from "../lane/machine.ts";
import * as CODES from "./codes.ts";
import {dispositionOf, RECIPE_ROUTES, RECIPE_VERBS, routeOf, seatedExits} from "./drive.ts";

/** Every code the group ships, minus the ones that are a refusal of `route` and not a run's exit. */
const runExits = (): ReadonlyArray<number> => {
	const notAnOutcome = new Set<number>([CODES.NO_RECIPE]);
	return [...new Set(Object.values(CODES))].filter((code) => !notAnOutcome.has(code));
};

const compiledChore = () => {
	const result = compile(choreWorkflow());
	if (result._tag !== "Compiled") throw new Error(`malformed: ${result.defects.join("; ")}`);
	return result.lane;
};

describe("the state → recipe table", () => {
	it("routes one state per recipe verb, so a state cannot apply two", () => {
		const states = RECIPE_ROUTES.map((row) => row.state);

		expect(new Set(states).size).toBe(states.length);
		expect(new Set(RECIPE_ROUTES.map((row) => row.verb))).toEqual(new Set(RECIPE_VERBS));
	});

	it("names what each recipe is pointed at, so the operator passes no guessed argument", () => {
		expect(routeOf("unpark")?.target).toBe("lane");
		expect(routeOf("rerun")?.target).toBe("pull");
	});

	it("routes nothing a chore machine handles itself — a queue, a park, a final, a stray name", () => {
		for (const state of ["queued", "human:novel-park", "swept", "frozen", "build", "nonsense"]) {
			expect(routeOf(state)).toBeNull();
		}
	});

	it("routes every state of the committed chore template that is not a queue, a park or a final", () => {
		const unrouted = Object.values(compiledChore().tasks).flatMap((task) =>
			Object.keys(task.machine.update as Record<string, unknown>).filter(
				(state) =>
					routeOf(state) === null &&
					state !== "queued" &&
					!state.startsWith("human:") &&
					!task.finals.has(state),
			),
		);

		expect(unrouted).toEqual([]);
	});
});

describe("the exit → event table", () => {
	it("records exactly one of the machine's six events for every exit, seated or not", () => {
		for (const verb of RECIPE_VERBS) {
			for (const code of [...runExits(), 0, 99]) {
				expect(isOperatorEvent(dispositionOf(verb, code).event)).toBe(true);
			}
		}
	});

	it("is closed over the group's exit table — every shipped code is seated by some verb", () => {
		const seated = new Set(RECIPE_VERBS.flatMap((verb) => seatedExits(verb)));

		expect(runExits().filter((code) => !seated.has(code))).toEqual([]);
	});

	it("seats no code the group does not ship, so a table row cannot outlive its exit", () => {
		const shipped = new Set([...runExits(), 0]);

		for (const verb of RECIPE_VERBS) {
			expect(seatedExits(verb).filter((code) => !shipped.has(code))).toEqual([]);
		}
	});

	it("folds the known-park clear's novel exit to a park the chore machine routes to a human", () => {
		const folded = dispositionOf("unpark", CODES.PARK_NOVEL);
		const unparkState = compiledChore().tasks.park_sweep?.machine.update as Record<
			string,
			Record<string, unknown>
		>;

		expect(folded.event).toBe("BLOCKED");
		expect(unparkState.unpark?.BLOCKED).toBeDefined();
		expect(
			(unparkState.unpark?.BLOCKED as (state: unknown) => readonly [{type: string}])({
				type: "unpark",
				retries: 0,
				maxRetries: 2,
			})[0].type,
		).toBe("human:novel-park");
	});

	it("holds a known park that is not clear yet on the state, never at a human", () => {
		expect(dispositionOf("unpark", CODES.PARK_HOLDS).event).toBe("WIP");
	});

	it("spends a retry only where the write itself did not land", () => {
		expect(dispositionOf("unpark", CODES.WRITE_UNKNOWN).event).toBe("FAIL");
		expect(dispositionOf("rerun", CODES.WRITE_UNKNOWN).event).toBe("FAIL");
		expect(dispositionOf("unpark", CODES.READBACK_MISMATCH).event).toBe("BLOCKED");
		expect(dispositionOf("rerun", CODES.READBACK_MISMATCH).event).toBe("BLOCKED");
	});

	it("reads a sweep that found no work as done, not as failed", () => {
		expect(dispositionOf("unpark", CODES.NOT_PARKED).event).toBe("DONE");
		expect(dispositionOf("rerun", CODES.NOTHING_TO_RERUN).event).toBe("DONE");
	});

	it("never reads an UNKNOWN as progress", () => {
		expect(dispositionOf("unpark", CODES.PRECONDITION_UNKNOWN).event).toBe("BLOCKED");
		expect(dispositionOf("rerun", CODES.RERUN_UNKNOWN).event).toBe("BLOCKED");
	});

	it("blocks on a code it has no reading for, and says the exit proved nothing", () => {
		const folded = dispositionOf("rerun", 77);

		expect(folded.event).toBe("BLOCKED");
		expect(folded.why).toMatch(/no reading for/);
	});
});
