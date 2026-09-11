/**
 * The class seed: what a label set reads as, what the seeded bytes carry, and the two answers that
 * are deliberately not a seed — an unclassed issue's untouched template and an off-set spelling.
 */
import {describe, expect, it} from "vitest";
import {classesFromLabels, renderClasses, seedClasses} from "./class-seed.ts";
import {coderTemplateText as template} from "./fixtures.test-support.ts";
import {compileText} from "./machine.ts";

describe("classesFromLabels", () => {
	it("reads the class stem off every class: label and nothing else", () => {
		expect(classesFromLabels(["type:bug", "class:ui", "p1", "ready-for:agent"])).toEqual(["ui"]);
	});

	it("answers empty for an issue carrying no class label", () => {
		expect(classesFromLabels(["type:bug", "p1"])).toEqual([]);
	});

	it("reports an off-set spelling rather than dropping it — a silent drop boots it unclassed", () => {
		expect(classesFromLabels(["class:UI"])).toEqual(["UI"]);
	});
});

describe("seedClasses", () => {
	it("leaves the template byte-identical when no class stands", () => {
		const text = template();
		const seed = seedClasses(text, []);
		expect(seed).toEqual({_tag: "Unchanged", text});
	});

	it("writes the class into every context entry the document declares", () => {
		const seed = seedClasses(template(), ["ui"]);
		if (seed._tag !== "Seeded") throw new Error(`expected Seeded, got ${seed._tag}`);
		const document = JSON.parse(seed.text) as {machine: {context: Record<string, unknown>}};
		expect(document.machine.context).toEqual({
			issue: {retries: 0, maxRetries: 3, classes: ["ui"], laps: 0, maxLaps: 16},
		});
	});

	it("seeds a document the compiler still reads, with the class on the task's initial state", () => {
		const seed = seedClasses(template(), ["ui"]);
		if (seed._tag !== "Seeded") throw new Error(`expected Seeded, got ${seed._tag}`);
		const compiled = compileText(seed.text);
		if (compiled._tag !== "Compiled") throw new Error(`expected Compiled: ${compiled.defects}`);
		expect(compiled.lane.tasks.issue?.initial.classes).toEqual(["ui"]);
	});

	it("refuses an off-set spelling instead of seeding a document nothing can route", () => {
		expect(seedClasses(template(), ["UI"])).toEqual({_tag: "OffSet", names: ["UI"]});
	});

	it("refuses a document declaring no task rather than placing it unclassed", () => {
		const seed = seedClasses(JSON.stringify({machine: {context: {}}}), ["ui"]);
		expect(seed._tag).toBe("Unseedable");
	});
});

describe("renderClasses", () => {
	it("quotes the names back as the labels a board carries", () => {
		expect(renderClasses(["ui", "doc"])).toBe("class:ui, class:doc");
	});
});
