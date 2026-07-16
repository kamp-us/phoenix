import {describe, expect, it} from "vitest";
import {getExhibit, listExhibits} from "./registry";

describe("exhibit registry — headless enumeration", () => {
	it("enumerates registered exhibits without rendering", () => {
		const exhibits = listExhibits();
		expect(exhibits.length).toBeGreaterThan(0);
		expect(exhibits.map((e) => e.id)).toContain("button");
	});

	it("registers the Button exhibit with a component and a knob schema", () => {
		const button = getExhibit("button");
		expect(button).toBeDefined();
		expect(button?.title).toBe("Düğme");
		expect(button?.component).toBeTruthy();
		expect(Object.keys(button?.knobs ?? {})).toContain("variant");
	});

	it("resolves by id and returns undefined for an unknown slug", () => {
		expect(getExhibit("button")?.id).toBe("button");
		expect(getExhibit("does-not-exist")).toBeUndefined();
	});

	it("holds unique ids (no two exhibits share a slug)", () => {
		const ids = listExhibits().map((e) => e.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
