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

	it("trims the title before deriving", () => {
		expect(conventionalTitleOf("  A padded title  ", ["type:bug"])).toBe("fix: A padded title");
	});
});
