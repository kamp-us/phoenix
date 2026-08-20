import {describe, expect, it} from "vitest";
import {SHIPPED_GOVERNED_ROOTS as GOVERNANCE_ROOTS} from "../review/classes.ts";
import {changeOf, deriveScope, recordsIn} from "./roots.ts";

const changed = (...rows: ReadonlyArray<readonly [string, string]>) =>
	rows.map(([status, path]) => ({status, path}));

describe("changeOf", () => {
	it("maps git's letters onto the three-word vocabulary", () => {
		expect(changeOf("A")).toBe("added");
		expect(changeOf("M")).toBe("modified");
		expect(changeOf("D")).toBe("deleted");
	});

	it("reads a rename as `added` — its path is the destination, which did not exist before", () => {
		expect(changeOf("R100")).toBe("added");
		expect(changeOf("C85")).toBe("added");
	});
});

describe("recordsIn", () => {
	it("names each four-digit record the diff carries, with what the diff does to it", () => {
		expect(
			recordsIn(
				changed(["A", ".decisions/0240-only-landed-adrs-may-be-cited.md"], ["M", "src/a.ts"]),
			),
		).toEqual([
			{id: "0240", change: "added", path: ".decisions/0240-only-landed-adrs-may-be-cited.md"},
		]);
	});

	it("reports a deleted record — the one corpus change added/modified cannot express", () => {
		expect(recordsIn(changed(["D", ".decisions/0099-gone.md"]))[0]?.change).toBe("deleted");
	});

	it("skips a lettered variant, which no sibling verb's four-digit `--record` addresses", () => {
		expect(recordsIn(changed(["M", ".decisions/0034a-live-fan-out-options.md"]))).toEqual([]);
	});
});

describe("deriveScope", () => {
	it("requires the namespace when any path is under any root, and tallies only touched roots", () => {
		const result = deriveScope(
			changed(
				["A", ".decisions/0240-x.md"],
				["M", "claude-plugins/fabrika/skills/review/SKILL.md"],
				["M", "src/a.ts"],
			),
			[],
			GOVERNANCE_ROOTS,
		);
		expect(result.required).toBe(true);
		expect(result.roots).toEqual({".decisions/": 1, "claude-plugins/": 1});
		expect(result.scanned).toBe(3);
	});

	it("orders the root histogram count-descending, not by the declared root order (ADR 0308)", () => {
		const result = deriveScope(
			changed(
				["M", "claude-plugins/fabrika/skills/review/SKILL.md"],
				["M", "claude-plugins/fabrika/skills/ship/SKILL.md"],
				["A", ".decisions/0240-x.md"],
			),
			[],
			GOVERNANCE_ROOTS,
		);
		expect(Object.entries(result.roots)).toEqual([
			["claude-plugins/", 2],
			[".decisions/", 1],
		]);
	});

	it("does not require it for a diff under no root", () => {
		expect(deriveScope(changed(["M", "src/a.ts"]), [], GOVERNANCE_ROOTS).required).toBe(false);
	});

	it("reads the root list from `review/classes.ts` rather than a second copy", () => {
		const each = GOVERNANCE_ROOTS.map(
			(root) => deriveScope(changed(["M", `${root}x`]), [], GOVERNANCE_ROOTS).required,
		);
		expect(each).toEqual(GOVERNANCE_ROOTS.map(() => true));
	});

	it("sets `self` when a changed path is under the resolved skill root", () => {
		const root = "claude-plugins/fabrika/skills/governance/";
		expect(deriveScope(changed(["M", `${root}SKILL.md`]), [root], GOVERNANCE_ROOTS).self).toBe(
			true,
		);
		expect(
			deriveScope(
				changed(["M", "claude-plugins/fabrika/skills/review/SKILL.md"]),
				[root],
				GOVERNANCE_ROOTS,
			).self,
		).toBe(false);
	});

	it("flags `self` under an AMBIGUOUS install rather than skipping the fence", () => {
		const roots = ["a/fabrika/skills/governance/", "b/fabrika/skills/governance/"];
		expect(
			deriveScope(changed(["M", "b/fabrika/skills/governance/SKILL.md"]), roots, GOVERNANCE_ROOTS)
				.self,
		).toBe(true);
	});

	it("leaves `self` false when no install resolved — there is nothing to be under", () => {
		expect(
			deriveScope(
				changed(["M", "claude-plugins/fabrika/skills/governance/SKILL.md"]),
				[],
				GOVERNANCE_ROOTS,
			).self,
		).toBe(false);
	});
});
