/** Unit — the `Scale` ordered ladder: `rank`, `gte`, `has`. */
import {describe, expect, it} from "vitest";
import {Scale} from "./Level.ts";

const ladder = Scale(["visitor", "çaylak", "yazar"]);

describe("Scale", () => {
	it("ranks names by their position, lowest-first", () => {
		expect(ladder.rank("visitor")).toBe(0);
		expect(ladder.rank("çaylak")).toBe(1);
		expect(ladder.rank("yazar")).toBe(2);
	});

	it("gte is the ladder's whole law — monotone, reflexive", () => {
		// a yazar passes any çaylak-floored gate (ADR 0107 §4)
		expect(ladder.gte("yazar", "çaylak")).toBe(true);
		expect(ladder.gte("yazar", "yazar")).toBe(true); // reflexive
		expect(ladder.gte("çaylak", "çaylak")).toBe(true);
		// a çaylak does not clear a yazar floor
		expect(ladder.gte("çaylak", "yazar")).toBe(false);
		expect(ladder.gte("visitor", "çaylak")).toBe(false);
	});

	it("has narrows an arbitrary string to a known rank", () => {
		expect(ladder.has("yazar")).toBe(true);
		expect(ladder.has("admin")).toBe(false);
	});
});
