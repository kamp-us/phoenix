/** The two derivations an epic run's assembly PR opens with, and the guard floor under the section. */
import {describe, expect, it} from "vitest";
import {bodyDefect} from "../build/pr-body.ts";
import {aboutSection, assemblyTitle, boundedParagraph, problemParagraph} from "./assembly-pr.ts";

const EPIC = ["type:epic"];

const pitched = (problem: string): string =>
	`## Pitch\n\n**Problem.** ${problem}\n\n**Arc.** Milestone #52.\n\n## Epic — awaiting plan\n`;

const sectionText = (problem: string, epic = 8201): string => {
	const read = aboutSection(epic, pitched(problem));
	if (read._tag !== "Section") throw new Error(`expected a section, got ${read._tag}`);
	return read.text;
};

describe("assemblyTitle", () => {
	it("prefixes an epic's own title with feat(epic):", () => {
		expect(assemblyTitle("Epic assembly PRs are titled by lane key", EPIC)).toBe(
			"feat(epic): Epic assembly PRs are titled by lane key",
		);
	});

	it("takes the conventional type from pr-title.ts rather than deriving one", () => {
		// `type:epic` → `feat` is that module's map; an unlabelled issue falls back to its `chore`.
		expect(assemblyTitle("Something", [])).toBe("chore(epic): Something");
	});

	it("restates the scope on a title that already leads with a conventional prefix", () => {
		expect(assemblyTitle("feat(desk)!: streamed replies", EPIC)).toBe(
			"feat(epic)!: streamed replies",
		);
	});

	it("strips a tag that would poison the Release PR body, as pr-title.ts does", () => {
		expect(assemblyTitle("<details> in a title", EPIC)).toBe("feat(epic): details in a title");
	});
});

describe("problemParagraph", () => {
	it("reads a `**Problem.**` label, the shape live epics carry", () => {
		expect(problemParagraph(pitched("The window shows nothing."))).toBe(
			"The window shows nothing.",
		);
	});

	it("reads a `**Problem:**` label too", () => {
		expect(problemParagraph("## Pitch\n\n**Problem:** Colons happen.\n")).toBe("Colons happen.");
	});

	it("keeps a paragraph wrapped over several lines whole, stopping at the blank line", () => {
		const body = "## Pitch\n\n**Problem.** One line,\nthen another.\n\nNot this one.\n";
		expect(problemParagraph(body)).toBe("One line, then another.");
	});

	it("stops at the next field's label where no blank line separates the five", () => {
		const body =
			"## Pitch\n\n**Problem:** The counters flood the log.\n**Arc:** axis:pipeline-hardening\n**Appetite:** 1 cycles\n";
		expect(problemParagraph(body)).toBe("The counters flood the log.");
	});

	it("is null when the body carries no `## Pitch` section", () => {
		expect(problemParagraph("## Summary\n\n**Problem.** Outside a pitch.\n")).toBeNull();
	});

	it("is null when the pitch names no Problem", () => {
		expect(problemParagraph("## Pitch\n\n**Arc.** Milestone #52.\n")).toBeNull();
	});

	it("is null when the Problem label is there and empty", () => {
		expect(problemParagraph("## Pitch\n\n**Problem.**\n\n**Arc.** Milestone #52.\n")).toBeNull();
	});

	it("does not read a plan-epic heading outside the pitch as a pitch field", () => {
		const body =
			"## Pitch\n\n**Arc.** Milestone #52.\n\n### Problem & who has it\n\nNot a field.\n";
		expect(problemParagraph(body)).toBeNull();
	});
});

describe("boundedParagraph", () => {
	it("keeps a short paragraph whole and marks nothing", () => {
		const short = "The window shows nothing. A long answer reads as a hang. Both are the same bug.";
		expect(boundedParagraph(short)).toBe(short);
	});

	it("keeps the opening sentence whole however long it runs", () => {
		const wall = `The founder asked whether the desk can open any session already on his machine and read the old chats, and named that as his condition for making it the daily driver, which ${"the picker cannot do ".repeat(12)}today.`;
		expect(boundedParagraph(wall)).toBe(wall);
	});

	it("stops before the sentence that would blow the budget, and says it did", () => {
		const lead = "Both mappers drop most of what their backend emits.";
		const wall = `${lead} ${"A path and a line number and a tag name and another one. ".repeat(8)}`;
		const bounded = boundedParagraph(wall);

		expect(bounded.startsWith(lead)).toBe(true);
		expect(bounded.endsWith("[…]")).toBe(true);
		expect(bounded.split(/\s+/).length).toBeLessThan(70);
	});

	it("takes no more than four sentences even when they are all short", () => {
		const bounded = boundedParagraph("One. Two. Three. Four. Five. Six.");
		expect(bounded).toBe("One. Two. Three. Four. […]");
	});

	it("does not split on the period inside a file name", () => {
		expect(boundedParagraph("Only `restore.ts` calls it.")).toBe("Only `restore.ts` calls it.");
	});
});

describe("aboutSection", () => {
	it("opens under the heading with the epic's own number", () => {
		expect(sectionText("The window shows nothing.")).toBe(
			"## About this epic\n\nEpic #8201: The window shows nothing.\n",
		);
	});

	it("swaps a closing keyword for a word GitHub does not link on, leaving the ref alone", () => {
		expect(sectionText("It also fixes #8122, which nobody wanted.")).toContain(
			"also repairs #8122, which nobody wanted.",
		);
	});

	it("keeps the swapped keyword's tense and its leading capital", () => {
		expect(sectionText("Closed #8122. Resolves #8123 too.")).toContain(
			"Settled #8122. Settles #8123 too.",
		);
	});

	it("leaves an issue ref no closing keyword aims at alone", () => {
		expect(sectionText("Filed beside #8122.")).toContain("Filed beside #8122.");
	});

	it("declassifies a quoted `type:` label and a bare priority token", () => {
		const text = sectionText("A type:epic issue at p1 is still a bet.");
		expect(text).toContain("A type epic issue at `p1` is still a bet.");
	});

	it("refuses a paragraph asserting control-plane membership rather than editing it", () => {
		expect(aboutSection(8201, pitched("This is control-plane work."))).toEqual({
			_tag: "Unsafe",
			what: "a control-plane classification claim",
		});
	});

	it("says which half of the pitch is missing rather than emitting an empty section", () => {
		expect(aboutSection(8201, "## Summary\n\nNo pitch here.\n")).toEqual({
			_tag: "Unpitched",
			why: "carries no `## Pitch` section",
		});
		expect(aboutSection(8201, "## Pitch\n\n**Arc.** Milestone #52.\n")).toEqual({
			_tag: "Unpitched",
			why: "carries a `## Pitch` with no Problem paragraph",
		});
	});

	it("adds nothing to an assembly PR body that `build pr`'s guard refuses", () => {
		const section = sectionText("It fixes #8122, a type:bug at p1.", 8070);
		const body = `${section}\nCloses #8070\n\n## Deviations\n\nNone.\n`;

		expect(bodyDefect(body, 8070, false)).toBeNull();
	});
});
