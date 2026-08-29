import {describe, expect, it} from "vitest";
import {PARK_CAUSES} from "../lane/report.ts";
import {classifyPark, isPark, KNOWN_PARKS} from "./parks.ts";

describe("the park table", () => {
	it("recognises the lane machine's two park shapes and nothing else", () => {
		expect(isPark("blocked")).toBe(true);
		expect(isPark("human:cp-approval")).toBe(true);
		expect(isPark("human:anything-later")).toBe(true);
		expect(isPark("build")).toBe(false);
		expect(isPark("shipped")).toBe(false);
	});

	it("names one park+cause per row, so two recipes cannot claim one park", () => {
		const keys = KNOWN_PARKS.map((row) => `${row.park}|${row.cause}`);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("keys every caused row on a cause a shell can actually record", () => {
		const named = KNOWN_PARKS.flatMap((row) => (row.cause === null ? [] : [row.cause]));

		expect(named.length).toBeGreaterThan(0);
		for (const cause of named) expect(Object.hasOwn(PARK_CAUSES, cause)).toBe(true);
	});
});

describe("classifyPark", () => {
	it("is Known for the §CP park, and carries the clearance the verb relays", () => {
		const parked = classifyPark("human:cp-approval", null);

		expect(parked._tag).toBe("Known");
		expect(parked._tag === "Known" && parked.recipe.clearance).toBe("cp-approval");
	});

	it("is Known for a BLOCKED whose cause is the worktree-holds-branch shape", () => {
		const parked = classifyPark("blocked", "worktree-holds-branch");

		expect(parked._tag).toBe("Known");
		expect(parked._tag === "Known" && parked.recipe.clearance).toBe("branch-free");
	});

	it("is Known for a BLOCKED whose cause is the campaign-paused shape (#7217)", () => {
		const parked = classifyPark("blocked", "campaign-paused");

		expect(parked._tag).toBe("Known");
		expect(parked._tag === "Known" && parked.recipe.clearance).toBe("campaign-active");
		// No verb may resume a campaign on a lane's behalf, so this row names no remedy to run first.
		expect(parked._tag === "Known" && parked.recipe.remedy).toBeNull();
	});

	it("is Novel for a bare BLOCKED, and says the ledger records no cause", () => {
		const parked = classifyPark("blocked", null);

		expect(parked._tag).toBe("Novel");
		expect(parked._tag === "Novel" && parked.reason).toMatch(/records the event and not its cause/);
	});

	it("is Novel for a BLOCKED whose cause no row covers, and names that cause", () => {
		const parked = classifyPark("blocked", "some-cause-nobody-wrote-a-row-for");

		expect(parked._tag).toBe("Novel");
		expect(parked._tag === "Novel" && parked.reason).toMatch(/some-cause-nobody-wrote-a-row-for/);
	});

	it("is Novel for the §CP park carrying a cause — a row matches the cause it names", () => {
		const parked = classifyPark("human:cp-approval", "worktree-holds-branch");

		expect(parked._tag).toBe("Novel");
	});

	it("is Novel for a human park the table does not carry", () => {
		const parked = classifyPark("human:some-future-park", null);

		expect(parked._tag).toBe("Novel");
		expect(parked._tag === "Novel" && parked.reason).toMatch(/human:some-future-park/);
	});

	it("is NotParked for a working state — never a park to clear", () => {
		expect(classifyPark("review", null)._tag).toBe("NotParked");
		expect(classifyPark("review", "worktree-holds-branch")._tag).toBe("NotParked");
	});
});
