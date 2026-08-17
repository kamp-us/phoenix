import {describe, expect, it} from "vitest";
import {classifyPark, isPark, KNOWN_PARKS} from "./parks.ts";

describe("the park table", () => {
	it("recognises the lane machine's two park shapes and nothing else", () => {
		expect(isPark("blocked")).toBe(true);
		expect(isPark("human:cp-approval")).toBe(true);
		expect(isPark("human:anything-later")).toBe(true);
		expect(isPark("build")).toBe(false);
		expect(isPark("shipped")).toBe(false);
	});

	it("names one park per row, so a recipe cannot cover two", () => {
		const parks = KNOWN_PARKS.map((row) => row.park);
		expect(new Set(parks).size).toBe(parks.length);
	});
});

describe("classifyPark", () => {
	it("is Known for the §CP park, and carries the clearance the verb relays", () => {
		const parked = classifyPark("human:cp-approval");

		expect(parked._tag).toBe("Known");
		expect(parked._tag === "Known" && parked.recipe.clearance).toBe("cp-approval");
	});

	it("is Novel for a bare BLOCKED, and says the ledger records no cause", () => {
		const parked = classifyPark("blocked");

		expect(parked._tag).toBe("Novel");
		expect(parked._tag === "Novel" && parked.reason).toMatch(/records the event and not its cause/);
	});

	it("is Novel for a human park the table does not carry", () => {
		const parked = classifyPark("human:some-future-park");

		expect(parked._tag).toBe("Novel");
		expect(parked._tag === "Novel" && parked.reason).toMatch(/human:some-future-park/);
	});

	it("is NotParked for a working state — never a park to clear", () => {
		expect(classifyPark("review")._tag).toBe("NotParked");
	});
});
