import {describe, expect, it} from "vitest";
import {loadConfig, resolve} from "../load.ts";
import {LANE_CONCURRENCY_CAP, laneConcurrencyCapKey} from "./lane-concurrency-cap.ts";

const declared = (value: unknown) =>
	resolve(
		loadConfig({_tag: "Text", text: JSON.stringify({[LANE_CONCURRENCY_CAP]: value})}),
		laneConcurrencyCapKey,
	);

describe("a repo that declares nothing is not capped", () => {
	it("resolves null for a repo with no config at all", () => {
		const resolved = resolve(loadConfig({_tag: "Absent"}), laneConcurrencyCapKey);
		expect(resolved._tag).toBe("Default");
		if (resolved._tag !== "Default") return;
		expect(resolved.value).toBeNull();
	});

	it("resolves null for a config that declares other keys and not this one", () => {
		const resolved = resolve(
			loadConfig({_tag: "Text", text: JSON.stringify({capClearAuthors: ["@someone"]})}),
			laneConcurrencyCapKey,
		);
		expect(resolved._tag).toBe("Default");
		if (resolved._tag !== "Default") return;
		expect(resolved.value).toBeNull();
	});
});

describe("a declared value is a positive integer, or null for no cap", () => {
	it("takes the number the repo wrote", () => {
		const resolved = declared(2);
		expect(resolved._tag).toBe("Declared");
		if (resolved._tag !== "Declared") return;
		expect(resolved.value).toBe(2);
	});

	it("takes an explicit null as the declared decline", () => {
		const resolved = declared(null);
		expect(resolved._tag).toBe("Declared");
		if (resolved._tag !== "Declared") return;
		expect(resolved.value).toBeNull();
	});

	// 0 is a cap no boot could ever clear, and every other value here is one the writer did not mean:
	// a silently-repaired cap is one the operator believes they set and did not.
	it.each([0, -1, "2", 1.5, true, [2], {cap: 2}])("refuses %p, naming the key", (value) => {
		const resolved = declared(value);
		expect(resolved._tag).toBe("Malformed");
		if (resolved._tag !== "Malformed") return;
		expect(resolved.reason).toContain(LANE_CONCURRENCY_CAP);
		expect(resolved.reason).toContain("positive integer");
	});
});
