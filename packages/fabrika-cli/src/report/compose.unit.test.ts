import {describe, expect, it} from "vitest";
import {
	checkSections,
	classifyingPrefix,
	composeBody,
	deriveVocabulary,
	labelKind,
	normalizeForReadback,
	REQUIRED_SECTIONS,
	renderFooter,
} from "./compose.ts";

const sections = (overrides: Partial<Record<string, string>> = {}): string =>
	REQUIRED_SECTIONS.map((h) => `${h}\n${overrides[h] ?? "content"}`).join("\n\n");

describe("checkSections", () => {
	it("accepts the six sections in order", () => {
		expect(checkSections(sections())).toBeNull();
	});

	it("accepts an empty suggested-next-step — a blank guess beats a misleading one", () => {
		expect(checkSections(sections({"## Suggested next step (non-binding)": ""}))).toBeNull();
	});

	it("names the one missing heading", () => {
		const body = sections().replace("## Pointers\ncontent", "");
		expect(checkSections(body)).toEqual({_tag: "Missing", heading: "## Pointers"});
	});

	it("catches a misspelled heading as the canonical one missing", () => {
		const body = sections().replace("## What I observed", "## What I Observed");
		expect(checkSections(body)).toEqual({_tag: "Missing", heading: "## What I observed"});
	});

	it("names both sides of an ordering violation", () => {
		const body = [
			"## Summary\ncontent",
			"## What I observed\ncontent",
			"## What I was doing\ncontent",
			"## Why it matters\ncontent",
			"## Pointers\ncontent",
			"## Suggested next step (non-binding)\n",
		].join("\n\n");
		expect(checkSections(body)).toEqual({
			_tag: "OutOfOrder",
			heading: "## What I was doing",
			after: "## What I observed",
		});
	});

	it("names an empty required section", () => {
		expect(checkSections(sections({"## Why it matters": "   "}))).toEqual({
			_tag: "Empty",
			heading: "## Why it matters",
		});
	});

	it("ignores extra sections the reporter added", () => {
		expect(checkSections(`${sections()}\n\n## Extra\nmore`)).toBeNull();
	});
});

describe("renderFooter", () => {
	it("renders every present field, separated by ` · `", () => {
		expect(
			renderFooter({
				session: "a0bd6818-7dda-4f64-8a1c-56e55c725214",
				model: "claude-opus-5",
				branch: "umut/fabrika-report-skill",
				timestamp: "2026-08-01T14:22:07Z",
			}),
		).toBe(
			"---\n<sub>Filed by an agent · session `a0bd6818-7dda-4f64-8a1c-56e55c725214` · model `claude-opus-5` · branch `umut/fabrika-report-skill` · 2026-08-01T14:22:07Z</sub>",
		);
	});

	it("takes each dropped field's separator with it — no placeholder, no dangling label", () => {
		expect(
			renderFooter({
				session: null,
				model: null,
				branch: "umut/fabrika-report-skill",
				timestamp: "2026-08-01T14:22:07Z",
			}),
		).toBe(
			"---\n<sub>Filed by an agent · branch `umut/fabrika-report-skill` · 2026-08-01T14:22:07Z</sub>",
		);
	});

	it("never drops the `Filed by an agent` marker — it is ADR 0159's never-auto-close signal", () => {
		expect(
			renderFooter({session: null, model: null, branch: null, timestamp: "2026-08-01T14:22:07Z"}),
		).toBe("---\n<sub>Filed by an agent · 2026-08-01T14:22:07Z</sub>");
	});
});

describe("composeBody", () => {
	it("puts the footer after the sections and a blank line", () => {
		expect(composeBody("## Summary\nx\n\n\n", "---\n<sub>f</sub>")).toBe(
			"## Summary\nx\n\n---\n<sub>f</sub>\n",
		);
	});
});

describe("deriveVocabulary", () => {
	const vocabulary = deriveVocabulary([
		"type:bug",
		"type:feature",
		"p0",
		"p2",
		"status:needs-triage",
		"area:pipeline",
	]);

	it("derives type and priority from the repo's own labels, not a hardcoded list", () => {
		expect(labelKind("type:bug", vocabulary)).toBe("type");
		expect(labelKind("p0", vocabulary)).toBe("priority");
		expect(labelKind("status:needs-triage", vocabulary)).toBeNull();
		expect(labelKind("area:pipeline", vocabulary)).toBeNull();
	});

	it("refuses a title that BOTH has the prefix shape AND resolves to the vocabulary", () => {
		expect(classifyingPrefix("BUG: fix retry", vocabulary)).toBe("BUG:");
		expect(classifyingPrefix("[p0] fix retry", vocabulary)).toBe("[p0]");
	});

	it("files a legitimate title whose first word merely happens to be a vocabulary term", () => {
		expect(classifyingPrefix("Bug reports from the sozluk form are lost", vocabulary)).toBeNull();
		expect(classifyingPrefix("Retry helper swallows the abort reason", vocabulary)).toBeNull();
	});

	it("leaves a prefix shape that names nothing in the vocabulary alone", () => {
		expect(classifyingPrefix("sozluk: definition editor loses focus", vocabulary)).toBeNull();
	});
});

describe("normalizeForReadback", () => {
	it("normalises line endings and per-line trailing whitespace, and nothing else", () => {
		expect(normalizeForReadback("a  \r\nb\t\n\n")).toBe("a\nb");
		expect(normalizeForReadback("a\nb")).toBe("a\nb");
	});

	it("still separates a body that genuinely differs", () => {
		expect(normalizeForReadback("a\nb")).not.toBe(normalizeForReadback("a\nc"));
	});
});
