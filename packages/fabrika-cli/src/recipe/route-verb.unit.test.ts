import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {NO_RECIPE, PARK_HOLDS, PARK_NOVEL} from "./codes.ts";
import {runRoute} from "./route-verb.ts";

const route = (state: string, exit: number | null = null) =>
	Effect.runSync(runRoute({state, exit}));

const answered = (state: string, exit: number | null = null): Record<string, unknown> => {
	const outcome = route(state, exit);
	expect(outcome.code).toBe(0);
	return JSON.parse(outcome.stdout) as Record<string, unknown>;
};

describe("recipe route — the routing half", () => {
	it("names the verb a chore state applies and what it is pointed at", () => {
		expect(answered("unpark")).toMatchObject({state: "unpark", verb: "unpark", target: "lane"});
		expect(answered("rerun")).toMatchObject({state: "rerun", verb: "rerun", target: "pull"});
	});

	it("refuses a state that applies no recipe, and lists the ones that do", () => {
		const outcome = route("queued");

		expect(outcome.code).toBe(NO_RECIPE);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toMatch(/unpark, rerun/);
	});

	it("refuses a park rather than running some verb over it", () => {
		expect(route("human:novel-park").code).toBe(NO_RECIPE);
	});
});

describe("recipe route — the folding half", () => {
	it("answers one machine event for the exit, with the reading that justifies it", () => {
		const folded = answered("unpark", PARK_NOVEL);

		expect(folded).toMatchObject({verb: "unpark", exit: PARK_NOVEL, event: "BLOCKED"});
		expect(String(folded.why)).toMatch(/outside the recipe table/);
	});

	it("keeps a holding park on the state instead of routing a human at it", () => {
		expect(answered("unpark", PARK_HOLDS).event).toBe("WIP");
	});

	it("answers BLOCKED for an exit the table has no reading for", () => {
		expect(answered("rerun", 77).event).toBe("BLOCKED");
	});

	it("still refuses an unrouted state, whatever exit it is handed", () => {
		expect(route("swept", 0).code).toBe(NO_RECIPE);
	});
});
