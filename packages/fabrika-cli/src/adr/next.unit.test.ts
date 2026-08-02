import {describe, expect, it} from "vitest";
import {allocate, padId} from "./next.ts";

describe("allocate", () => {
	it("is max(union) + 1, NOT the first free number in it", () => {
		// The contract's discriminating example: first-free would answer 0238.
		const result = allocate(["0234", "0235", "0236"], ["0237", "0239"]);
		expect(result.id).toBe("0240");
		expect(result.mergedMax).toBe("0236");
		expect(result.inFlight).toEqual(["0237", "0239"]);
	});

	it("leaves a gap below the maximum rather than re-issuing an abandoned number", () => {
		expect(allocate(["0001", "0005"], []).id).toBe("0006");
	});

	it("treats an empty in-flight set as a fact — the caller has already refused an unread one", () => {
		expect(allocate(["0236"], []).id).toBe("0237");
	});

	it("does not let a lettered id advance allocation", () => {
		expect(allocate(["0034", "0034a"], []).id).toBe("0035");
	});

	it("de-duplicates and orders the in-flight set", () => {
		expect(allocate(["0010"], ["0012", "0011", "0012"]).inFlight).toEqual(["0011", "0012"]);
	});
});

describe("padId", () => {
	it("pads to four digits and does not truncate a wider one", () => {
		expect(padId(7)).toBe("0007");
		expect(padId(12345)).toBe("12345");
	});
});
