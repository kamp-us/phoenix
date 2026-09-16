import {describe, expect, it} from "vitest";
import {classLabel} from "./config/board.ts";
import {CLASS_LABELS, STATUSES} from "./labels.ts";
import {CLASSES} from "./triage/facets.ts";

describe("CLASS_LABELS", () => {
	it("is the four class labels the stamp writes, in the partition's order", () => {
		expect(CLASS_LABELS).toEqual(["class:code", "class:doc", "class:skill", "class:ui"]);
	});

	it("is derived from the closed CLASSES set, so a fifth class widens the bootstrap here", () => {
		expect(CLASS_LABELS).toEqual(CLASSES.map(classLabel));
		expect(CLASS_LABELS).toHaveLength(CLASSES.length);
	});

	it("names no status, so the two bootstrap rows cannot mint one label twice", () => {
		expect(CLASS_LABELS.filter((label) => STATUSES.includes(label))).toEqual([]);
	});
});
