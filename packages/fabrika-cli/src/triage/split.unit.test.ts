import {describe, expect, it} from "vitest";
import {renderFooter} from "../report/compose.ts";
import {
	backReference,
	composeChildBody,
	crossLinkComment,
	hasBackReference,
	isExistingChild,
	normalizeTitle,
} from "./split.ts";

/** The predecessor's key, reproduced so the Turkish collapse is asserted rather than asserted about. */
const asciiNormalize = (title: string): string =>
	title
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t !== "")
		.join(" ");

const child = (over: Partial<Parameters<typeof isExistingChild>[0]> = {}) => ({
	number: 4321,
	title: "Editor loses focus after save",
	body: "The editor drops focus.\n\nsplit from #4312\n",
	url: "https://example.test/issues/4321",
	...over,
});

describe("normalizeTitle", () => {
	it("is case- and punctuation-insensitive", () => {
		expect(normalizeTitle("Editor loses focus — after save!")).toBe(
			normalizeTitle("editor loses focus after save"),
		);
	});

	it("keeps two Turkish titles distinct where an ASCII key collapses them", () => {
		const a = "Başlık düşüyor";
		const b = "Başlık döşüyor";
		// The hazard, proven: the ASCII key cannot tell these apart, so the second would be falsely
		// REUSED — a split silently lost.
		expect(asciiNormalize(a)).toBe(asciiNormalize(b));
		expect(normalizeTitle(a)).not.toBe(normalizeTitle(b));
	});

	it("keeps Turkish letters instead of dropping them", () => {
		expect(normalizeTitle("Sözlük tanımı")).toBe("sözlük tanımı");
	});

	it("folds canonically-equivalent spellings of one title together", () => {
		expect(normalizeTitle("Sözlük")).toBe(normalizeTitle("Sözlük".normalize("NFD")));
	});
});

describe("hasBackReference", () => {
	it("finds the reference the verb itself writes", () => {
		expect(hasBackReference(`x\n\n${backReference(4312)}\n`, 4312)).toBe(true);
	});

	it("does not let #431 answer for #43 — a longer number is a different parent", () => {
		expect(hasBackReference("split from #431", 43)).toBe(false);
	});

	it("is absent when the body never carried one", () => {
		expect(hasBackReference("a body with no provenance at all", 4312)).toBe(false);
	});
});

describe("isExistingChild", () => {
	it("matches on both halves of the key", () => {
		expect(isExistingChild(child(), 4312, "Editor loses focus after save")).toBe(true);
	});

	it("refuses a title-only match — a same-titled child of ANOTHER parent is not this child", () => {
		expect(
			isExistingChild(child({body: "split from #9999"}), 4312, "Editor loses focus after save"),
		).toBe(false);
	});

	it("refuses a back-reference-only match — a sibling split from the same parent is not this child", () => {
		expect(
			isExistingChild(
				child({title: "Autosave drops the draft"}),
				4312,
				"Editor loses focus after save",
			),
		).toBe(false);
	});
});

describe("composeChildBody", () => {
	const footer = renderFooter({
		session: "s",
		model: null,
		branch: null,
		timestamp: "2026-01-01T00:00:00Z",
	});

	it("puts the caller's bytes first, then the back-reference, then the footer", () => {
		expect(composeChildBody("The editor drops focus.", 4312, footer)).toBe(
			"The editor drops focus.\n\nsplit from #4312\n\n---\n<sub>Filed by an agent · session `s` · 2026-01-01T00:00:00Z</sub>\n",
		);
	});

	it("carries the agent footer, without which the child could never be killed (ADR 0159)", () => {
		expect(composeChildBody("x", 4312, footer)).toContain("Filed by an agent");
	});

	it("writes a back-reference its own matcher reads back", () => {
		expect(hasBackReference(composeChildBody("x", 4312, footer), 4312)).toBe(true);
	});
});

describe("crossLinkComment", () => {
	it("names the child", () => {
		expect(crossLinkComment(4321)).toBe("split into #4321");
	});
});
