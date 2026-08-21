import {describe, expect, it} from "vitest";
import {conventionalTitleOf} from "./pr-title.ts";

describe("conventionalTitleOf", () => {
	it("derives fix from type:bug", () => {
		expect(
			conventionalTitleOf("Builder PR titles are not conventional commits", [
				"type:bug",
				"status:triaged",
				"p1",
				"ready-for:agent",
			]),
		).toBe("fix: Builder PR titles are not conventional commits");
	});

	it("derives feat from type:feature", () => {
		expect(conventionalTitleOf("Add a sozluk term page", ["type:feature", "p2"])).toBe(
			"feat: Add a sozluk term page",
		);
	});

	// #6754: the epic tail squashes to a subject on `main`, and a type the node strategy hides drops
	// the whole epic's changes from the release notes. These are the hidden types in the
	// conventionalcommits preset's default `config.types`.
	const HIDDEN_TYPES = ["chore", "docs", "style", "refactor", "test", "build", "ci"];

	it("derives a type release-please shows from type:epic, never a hidden one", () => {
		const title = conventionalTitleOf("Retire the v1 pipeline plugin", [
			"type:epic",
			"status:triaged",
			"ready-for:agent",
		]);
		expect(title).toBe("feat: Retire the v1 pipeline plugin");
		for (const hidden of HIDDEN_TYPES) {
			expect(title.startsWith(`${hidden}:`)).toBe(false);
		}
	});

	it("falls back to chore for every other type label", () => {
		expect(conventionalTitleOf("Sweep the stale worktrees", ["type:chore"])).toBe(
			"chore: Sweep the stale worktrees",
		);
		expect(conventionalTitleOf("Why is the queue stuck?", ["type:investigation"])).toBe(
			"chore: Why is the queue stuck?",
		);
		expect(conventionalTitleOf("No type label at all", ["p1"])).toBe("chore: No type label at all");
	});

	// The squash rule reads the PR title verbatim, so a hand-prefixed title must pass through
	// untouched — `fix: docs: …` would be worse than what it replaces.
	it("leaves an already-conventional title alone rather than double-prefixing", () => {
		expect(conventionalTitleOf("fix(fabrika): route the map open", ["type:bug"])).toBe(
			"fix(fabrika): route the map open",
		);
		expect(conventionalTitleOf("docs: repoint the dead links", ["type:chore"])).toBe(
			"docs: repoint the dead links",
		);
		expect(conventionalTitleOf("feat!: drop the legacy wire format", ["type:feature"])).toBe(
			"feat!: drop the legacy wire format",
		);
	});

	it("does not read a plain sentence with a colon as already prefixed", () => {
		expect(conventionalTitleOf("One retry cap: fold the three round budgets", ["type:bug"])).toBe(
			"fix: One retry cap: fold the three round budgets",
		);
		expect(conventionalTitleOf("Sözlük: seed the first terms", ["type:feature"])).toBe(
			"feat: Sözlük: seed the first terms",
		);
	});

	// #5946: a subject with a literal tag poisons the Release PR body's changelog, and every later
	// release-please run crashes parsing that body as HTML.
	it("strips the brackets off an HTML-looking tag so the subject cannot open one", () => {
		expect(
			conventionalTitleOf("read acceptance criteria outside a `<details>` appendix", ["type:bug"]),
		).toBe("fix: read acceptance criteria outside a `details` appendix");
		expect(conventionalTitleOf("drop the </summary> guard", ["type:chore"])).toBe(
			"chore: drop the summary guard",
		);
		expect(conventionalTitleOf("escape <script src=x> in bios", ["type:bug"])).toBe(
			"fix: escape script src=x in bios",
		);
	});

	it("strips tags from an already-conventional title too", () => {
		expect(
			conventionalTitleOf("fix(wire): read outside a `<details>` appendix", ["type:bug"]),
		).toBe("fix(wire): read outside a `details` appendix");
	});

	it("leaves an angle bracket no parser opens a tag on alone", () => {
		expect(conventionalTitleOf("fail when depth < 3 and count > 0", ["type:bug"])).toBe(
			"fix: fail when depth < 3 and count > 0",
		);
	});

	it("trims the title before deriving", () => {
		expect(conventionalTitleOf("  A padded title  ", ["type:bug"])).toBe("fix: A padded title");
	});
});
