import {describe, expect, it} from "vitest";
import {scannedLine} from "./scope.ts";

describe("scannedLine", () => {
	it("names the verb, the count, the noun and the repo", () => {
		expect(scannedLine("queue", "kamp-us/phoenix", 12, "issue")).toBe(
			"queue: scanned 12 issues in kamp-us/phoenix.",
		);
	});

	it("prints a zero count rather than staying silent — the refusal is where scope matters most", () => {
		expect(scannedLine("homes", "kamp-us/phoenix", 0, "milestone")).toBe(
			"homes: scanned 0 milestones in kamp-us/phoenix.",
		);
	});

	it("singularizes a count of one", () => {
		expect(scannedLine("homes", "kamp-us/phoenix", 1, "milestone")).toBe(
			"homes: scanned 1 milestone in kamp-us/phoenix.",
		);
	});

	it("appends a note when one is given, and nothing when it is not", () => {
		expect(scannedLine("queue", "kamp-us/phoenix", 3, "issue", "2 already claimed")).toBe(
			"queue: scanned 3 issues in kamp-us/phoenix; 2 already claimed.",
		);
		expect(scannedLine("queue", "kamp-us/phoenix", 3, "issue")).not.toContain(";");
	});
});
