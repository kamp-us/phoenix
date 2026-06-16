import {assert, describe, it} from "@effect/vitest";
import {
	type ChangelogEntry,
	categoryFor,
	deriveChangelog,
	groupByType,
	renderSection,
} from "./changelog.ts";

const entry = (over: Partial<ChangelogEntry> & {issue: number}): ChangelogEntry => ({
	title: `entry ${over.issue}`,
	...over,
});

describe("categoryFor — type:* → Keep-a-Changelog category map", () => {
	it("maps feature → Added", () => {
		assert.strictEqual(categoryFor("feature"), "Added");
	});

	it("maps bug → Fixed", () => {
		assert.strictEqual(categoryFor("bug"), "Fixed");
	});

	it("maps chore → Changed", () => {
		assert.strictEqual(categoryFor("chore"), "Changed");
	});

	it("maps decision → Decisions", () => {
		assert.strictEqual(categoryFor("decision"), "Decisions");
	});

	it("maps investigation → Changed", () => {
		assert.strictEqual(categoryFor("investigation"), "Changed");
	});

	it("maps epic → Changed", () => {
		assert.strictEqual(categoryFor("epic"), "Changed");
	});

	it("maps an absent type → Uncategorized (flagged, not dropped)", () => {
		assert.strictEqual(categoryFor(undefined), "Uncategorized");
	});

	it("maps an unknown type → Uncategorized (flagged, not dropped)", () => {
		assert.strictEqual(categoryFor("mystery"), "Uncategorized");
	});
});

describe("groupByType", () => {
	it("buckets entries by mapped category in CATEGORY_ORDER", () => {
		const groups = groupByType([
			entry({issue: 1, type: "bug"}),
			entry({issue: 2, type: "feature"}),
			entry({issue: 3, type: "chore"}),
			entry({issue: 4, type: "decision"}),
		]);
		assert.deepStrictEqual(
			groups.map((g) => g.category),
			["Added", "Changed", "Fixed", "Decisions"],
		);
	});

	it("omits empty categories", () => {
		const groups = groupByType([entry({issue: 1, type: "feature"})]);
		assert.deepStrictEqual(
			groups.map((g) => g.category),
			["Added"],
		);
	});

	it("preserves input order within a category", () => {
		const groups = groupByType([
			entry({issue: 10, type: "feature"}),
			entry({issue: 11, type: "feature"}),
		]);
		assert.deepStrictEqual(
			groups[0]?.entries.map((e) => e.issue),
			[10, 11],
		);
	});

	it("routes a type-less entry into Uncategorized, never dropping it", () => {
		const groups = groupByType([entry({issue: 99})]);
		const uncategorized = groups.find((g) => g.category === "Uncategorized");
		assert.isDefined(uncategorized);
		assert.strictEqual(uncategorized?.entries.length, 1);
		assert.strictEqual(uncategorized?.entries[0]?.issue, 99);
	});

	it("never loses an entry: total count is conserved", () => {
		const input = [
			entry({issue: 1, type: "feature"}),
			entry({issue: 2, type: "bug"}),
			entry({issue: 3}),
			entry({issue: 4, type: "weird"}),
		];
		const total = groupByType(input).reduce((n, g) => n + g.entries.length, 0);
		assert.strictEqual(total, input.length);
	});
});

describe("renderSection — one Keep-a-Changelog release block", () => {
	it("emits a ## [version] — date heading", () => {
		const md = renderSection({version: "0.1.0", date: "2026-06-15"}, [
			entry({issue: 1, type: "feature"}),
		]);
		assert.match(md, /^## \[0\.1\.0\] — 2026-06-15/);
	});

	it("groups entries under ### Category headings", () => {
		const md = renderSection({version: "0.1.0", date: "2026-06-15"}, [
			entry({issue: 1, type: "feature", title: "add widget"}),
			entry({issue: 2, type: "bug", title: "fix crash"}),
		]);
		assert.include(md, "### Added");
		assert.include(md, "### Fixed");
		assert.include(md, "- add widget");
		assert.include(md, "- fix crash");
	});

	it("backlinks the merged PR number when present", () => {
		const md = renderSection({version: "0.1.0", date: "2026-06-15"}, [
			entry({issue: 1, pr: 42, type: "feature", title: "add widget"}),
		]);
		assert.include(md, "- add widget (#42)");
	});

	it("backlinks the issue number when no PR is known", () => {
		const md = renderSection({version: "0.1.0", date: "2026-06-15"}, [
			entry({issue: 7, type: "feature", title: "add widget"}),
		]);
		assert.include(md, "- add widget (#7)");
	});

	it("renders Uncategorized entries visibly (flagged, not dropped)", () => {
		const md = renderSection({version: "0.1.0", date: "2026-06-15"}, [
			entry({issue: 13, title: "untyped work"}),
		]);
		assert.include(md, "### Uncategorized");
		assert.include(md, "- untyped work (#13)");
	});

	it("notes an empty range rather than erroring", () => {
		const md = renderSection({version: "0.1.0", date: "2026-06-15"}, []);
		assert.include(md, "## [0.1.0] — 2026-06-15");
		assert.include(md, "No closed issues");
	});
});

describe("deriveChangelog — full file projection", () => {
	it("emits the Keep a Changelog header and a generated-file notice", () => {
		const md = deriveChangelog([
			{meta: {version: "0.1.0", date: "2026-06-15"}, entries: [entry({issue: 1, type: "feature"})]},
		]);
		assert.match(md, /^# Changelog/);
		assert.include(md, "generated");
		assert.include(md, "Keep a Changelog");
	});

	it("renders releases newest-first in caller-supplied order", () => {
		const md = deriveChangelog([
			{meta: {version: "0.2.0", date: "2026-07-01"}, entries: [entry({issue: 2, type: "feature"})]},
			{meta: {version: "0.1.0", date: "2026-06-15"}, entries: [entry({issue: 1, type: "feature"})]},
		]);
		assert.isBelow(md.indexOf("[0.2.0]"), md.indexOf("[0.1.0]"));
	});

	it("ends with a trailing newline", () => {
		const md = deriveChangelog([{meta: {version: "0.1.0", date: "2026-06-15"}, entries: []}]);
		assert.isTrue(md.endsWith("\n"));
	});
});
