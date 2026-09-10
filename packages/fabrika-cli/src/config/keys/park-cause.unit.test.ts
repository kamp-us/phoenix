import {describe, expect, it} from "vitest";
import {LANE_UNREADABLE} from "../../lane/codes.ts";
import {parkCauseRefusal} from "../../lane/park-cause-rule.ts";
import {loadConfig, resolve} from "../load.ts";
import type {Read} from "../read-key.ts";
import {PARK_CAUSE, type ParkCauseSurface, parkCauseKey, SHIPPED_PARK_CAUSE} from "./park-cause.ts";

const declared = (config: unknown) =>
	resolve(loadConfig({_tag: "Text", text: JSON.stringify({[PARK_CAUSE]: config})}), parkCauseKey);

const read = (value: ParkCauseSurface): Read<ParkCauseSurface> => ({
	_tag: "Value",
	value,
	note: "test",
});

describe("the shipped park-cause surface", () => {
	// The containment: this slice alone cannot brick a live lane, because every repo that declares
	// nothing keeps recording the bare park it always did.
	it("is `record` for a repo with no config at all — today's behaviour, not a new strictness", () => {
		const resolved = resolve(loadConfig({_tag: "Absent"}), parkCauseKey);

		expect(resolved._tag).toBe("Default");
		if (resolved._tag !== "Default") return;
		expect(resolved.value).toEqual({uncaused: "record"});
		expect(SHIPPED_PARK_CAUSE.uncaused).toBe("record");
	});

	it("falls to the shipped value for a declared key that leaves the sub-key out", () => {
		const resolved = declared({});

		expect(resolved._tag).toBe("Declared");
		if (resolved._tag !== "Declared") return;
		expect(resolved.value.uncaused).toBe(SHIPPED_PARK_CAUSE.uncaused);
	});

	it("takes the strict arm a repo declares for itself", () => {
		const resolved = declared({uncaused: "refuse"});

		expect(resolved._tag).toBe("Declared");
		if (resolved._tag !== "Declared") return;
		expect(resolved.value.uncaused).toBe("refuse");
	});
});

describe("an off-vocabulary or malformed value is refused at load", () => {
	it("refuses an uncaused outside record | refuse", () => {
		const resolved = declared({uncaused: "ignore"});

		expect(resolved._tag).toBe("Malformed");
		if (resolved._tag !== "Malformed") return;
		expect(resolved.reason).toContain("is not one of record, refuse");
	});

	it.each([null, 3, ["record"]])("refuses a non-string uncaused (%p)", (value) => {
		expect(declared({uncaused: value})._tag).toBe("Malformed");
	});

	it("refuses a sub-key this module does not own, rather than dropping it", () => {
		const resolved = declared({uncausedd: "refuse"});

		expect(resolved._tag).toBe("Malformed");
		if (resolved._tag !== "Malformed") return;
		expect(resolved.reason).toContain("is not a park-cause setting");
	});

	it.each([null, "refuse", ["refuse"]])("refuses a key that is not an object (%p)", (value) => {
		expect(declared(value)._tag).toBe("Malformed");
	});
});

describe("parkCauseRefusal", () => {
	it("resolves the permissive arm to requireCause false", () => {
		expect(parkCauseRefusal("verb", read({uncaused: "record"}))).toEqual({
			_tag: "Resolved",
			requireCause: false,
		});
	});

	it("resolves the strict arm to requireCause true", () => {
		expect(parkCauseRefusal("verb", read({uncaused: "refuse"}))).toEqual({
			_tag: "Resolved",
			requireCause: true,
		});
	});

	// Never a fallback to the shipped default: that would silently restore the permissive arm in a
	// repo that declared the strict one.
	it("refuses UNKNOWN rather than falling back on a config nobody could read", () => {
		const rule = parkCauseRefusal("verb", {_tag: "Refused", reason: "EACCES"});

		expect(rule._tag).toBe("Refused");
		if (rule._tag !== "Refused") return;
		expect(rule.outcome.code).toBe(LANE_UNREADABLE);
		expect(rule.outcome.stderr.join(" ")).toContain("UNKNOWN");
		expect(rule.outcome.stderr.join(" ")).toContain("unappended");
	});
});
