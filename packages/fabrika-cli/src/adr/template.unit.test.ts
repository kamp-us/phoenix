import {describe, expect, it} from "vitest";
import {parseTags, recordFilename, renderTemplate, titleFromSlug} from "./template.ts";

const rendered = renderTemplate({
	id: "0940",
	slug: "only-landed-adrs-may-be-cited",
	title: "An ADR may cite only an ADR that has landed on the base ref",
	status: "accepted",
	date: "2026-08-01",
	tags: ["decisions", "gates"],
});

describe("renderTemplate", () => {
	it("substitutes the five frontmatter fields", () => {
		expect(rendered).toContain("id: 0940");
		expect(rendered).toContain(
			"title: An ADR may cite only an ADR that has landed on the base ref",
		);
		expect(rendered).toContain("status: accepted");
		expect(rendered).toContain("date: 2026-08-01");
		expect(rendered).toContain("tags: [decisions, gates]");
	});

	it("repeats the title verbatim in the H1", () => {
		expect(rendered).toContain(
			"# 0940 — An ADR may cite only an ADR that has landed on the base ref",
		);
	});

	it("carries the required What-this-decides line the founder reads", () => {
		expect(rendered).toContain("**What this decides:**");
	});

	it("scaffolds Context / Decision / Consequences and NOT Records / Amendments", () => {
		expect(rendered).toContain("## Context");
		expect(rendered).toContain("## Decision");
		expect(rendered).toContain("## Consequences");
		expect(rendered).not.toContain("## Records");
		expect(rendered).not.toContain("## Amendments");
	});

	it("ends with a single trailing newline", () => {
		expect(rendered.endsWith("cost.>\n")).toBe(true);
	});

	it("renders an empty tag list as []", () => {
		expect(
			renderTemplate({
				id: "0001",
				slug: "a",
				title: "a",
				status: "accepted",
				date: "2026-01-01",
				tags: [],
			}),
		).toContain("tags: []");
	});
});

describe("defaults", () => {
	it("de-hyphenates the slug for the default title", () => {
		expect(titleFromSlug("only-landed-adrs-may-be-cited")).toBe("only landed adrs may be cited");
	});

	it("splits tags on commas and drops empties", () => {
		expect(parseTags(" a , b ,, c ")).toEqual(["a", "b", "c"]);
		expect(parseTags("")).toEqual([]);
	});

	it("builds the record filename", () => {
		expect(recordFilename("0940", "a-b")).toBe("0940-a-b.md");
	});
});
