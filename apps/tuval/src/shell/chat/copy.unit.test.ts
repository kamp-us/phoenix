/**
 * Tuval's English catalog for the shared primitives. The type already makes the map total; what a
 * test has to hold is that no line slipped back into Turkish and that no line names a backend,
 * because either would make the one shared window stop being backend-blind.
 */

import {describe, expect, it} from "vitest";
import {tuvalDesignMessages, tuvalDesignTranslate} from "./copy.ts";

const entries = Object.entries(tuvalDesignMessages);

describe("the Tuval design catalog", () => {
	it("covers every key the package declares", () => {
		expect(entries.length).toBeGreaterThan(100);
		expect(entries.every(([, value]) => value.length > 0)).toBe(true);
	});

	it("carries no Turkish letter, so nothing falls back to the package's own copy", () => {
		const turkish = /[çğıöşüÇĞİÖŞÜ]/;
		expect(entries.filter(([, value]) => turkish.test(value))).toEqual([]);
	});

	it("names no backend, because one window renders every agent", () => {
		const backend = /\b(Pi|Claude|Anthropic)\b/;
		expect(entries.filter(([, value]) => backend.test(value))).toEqual([]);
	});

	it("substitutes a parameter and leaves an unknown one alone", () => {
		expect(tuvalDesignTranslate("admin.agent.status.readyWithModel", {model: "luna"})).toBe(
			"The agent is ready · luna",
		);
		expect(tuvalDesignTranslate("admin.agent.activity.tool", {other: "x"})).toBe(
			"The agent is using {tool}.",
		);
		expect(tuvalDesignTranslate("admin.agent.send")).toBe("send");
	});
});
