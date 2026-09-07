import {describe, expect, it} from "vitest";
import {scannedLine} from "./scope.ts";

describe("scannedLine", () => {
	it("names the verb, the count, the noun and the repo", () => {
		expect(scannedLine("queue", "o/r", 12, "issue")).toBe("queue: scanned 12 issues in o/r.");
	});

	it("prints a zero count rather than staying silent — the refusal is where scope matters most", () => {
		expect(scannedLine("homes", "o/r", 0, "milestone")).toBe("homes: scanned 0 milestones in o/r.");
	});

	it("singularizes a count of one", () => {
		expect(scannedLine("homes", "o/r", 1, "milestone")).toBe("homes: scanned 1 milestone in o/r.");
	});

	it("appends a note when one is given, and nothing when it is not", () => {
		expect(scannedLine("queue", "o/r", 3, "issue", "2 already claimed")).toBe(
			"queue: scanned 3 issues in o/r; 2 already claimed.",
		);
		expect(scannedLine("queue", "o/r", 3, "issue")).not.toContain(";");
	});
});
