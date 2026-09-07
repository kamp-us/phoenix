import {describe, expect, it} from "vitest";
import {
	classOf,
	DECISIONS_ROOT,
	SHIPPED_GOVERNED_ROOTS as GOVERNANCE_ROOTS,
	issueRefOf,
	issueRefsOf,
	isUiSurface,
	linkedIssueOf,
	linkedIssuesOf,
	namespacesOf,
	partition,
	partitionWithUi,
	SHIP_CLASS_NAMES,
	SHIP_NAMESPACES,
	shipNamespacesOf,
	touchesGovernanceRoot,
} from "./classes.ts";

/** One repo's own declared prefixes — two runnable apps, one of them served by two mounts. */
const UI_PREFIXES = ["apps/site/src/", "apps/desk/src/"];

describe("classOf", () => {
	it("puts every claude-plugins and .claude path in skill", () => {
		expect(classOf("claude-plugins/fabrika/skills/review/SKILL.md")).toBe("skill");
		expect(classOf("claude-plugins/fabrika/docs/cli-interface-convention.md")).toBe("skill");
		expect(classOf(".claude/agents/coder.md")).toBe("skill");
	});

	it("keeps the two portability rows honest on a repo that homes skills elsewhere", () => {
		// Found live by an eval run: under the first two rows alone this partitions to `doc`.
		expect(classOf("skills/deploy-notes/SKILL.md")).toBe("skill");
		expect(classOf("some/other/place/SKILL.md")).toBe("skill");
	});

	it("puts markdown outside claude-plugins in doc", () => {
		expect(classOf(`${DECISIONS_ROOT}fabrika.md`)).toBe("doc");
		expect(classOf("README.md")).toBe("doc");
		expect(classOf(".patterns/index.md")).toBe("doc");
	});

	it("makes code the residual — a file the map cannot place is never dropped", () => {
		expect(classOf("packages/fabrika-cli/src/review/codes.ts")).toBe("code");
		expect(classOf(".github/workflows/ci.yml")).toBe("code");
		expect(classOf("LICENSE")).toBe("code");
		expect(classOf("weird-file-with-no-extension")).toBe("code");
	});
});

describe("partition", () => {
	it("counts each present class and omits the absent ones", () => {
		const result = partition(["src/a.ts", "src/b.ts", "README.md"]);
		expect(result.classes).toEqual([
			{name: "code", files: 2},
			{name: "doc", files: 1},
		]);
		expect(result.scanned).toBe(3);
	});

	it("is total — every file lands in exactly one class", () => {
		const files = ["a.ts", "b.md", "claude-plugins/x/SKILL.md", "no-extension"];
		const result = partition(files);
		expect(result.classes.reduce((sum, entry) => sum + entry.files, 0)).toBe(files.length);
	});

	it("sets self only for the review skill's own text", () => {
		expect(partition(["claude-plugins/fabrika/skills/review/SKILL.md"]).self).toBe(true);
		expect(partition(["claude-plugins/fabrika/skills/triage/SKILL.md"]).self).toBe(false);
	});

	it("sets harness on the closed three-root list, and not on the portability rows", () => {
		expect(partition([".github/workflows/ci.yml"]).harness).toBe(true);
		expect(partition([".claude/settings.json"]).harness).toBe(true);
		expect(partition(["claude-plugins/fabrika/x.md"]).harness).toBe(true);
		// A foreign repo's skill text is classified for the rubric but marks no harness of ours.
		expect(partition(["skills/deploy-notes/SKILL.md"]).harness).toBe(false);
	});

	it("derives one namespace per present class, as a set the caller cannot forget", () => {
		expect(namespacesOf(partition(["a.ts", "b.md"]))).toEqual(["review-code", "review-doc"]);
		expect(namespacesOf(partition(["b.md"]))).toEqual(["review-doc"]);
	});
});

describe("SHIP_NAMESPACES", () => {
	it("still admits every review class, and now governance too (#5199)", () => {
		for (const name of SHIP_CLASS_NAMES) expect(SHIP_NAMESPACES).toContain(`review-${name}`);
		expect(SHIP_NAMESPACES).toContain("governance");
		expect(SHIP_NAMESPACES).toHaveLength(SHIP_CLASS_NAMES.length + 1);
	});
});

describe("touchesGovernanceRoot", () => {
	it("fires on each shipped root, at any depth — the config file among them", () => {
		expect(GOVERNANCE_ROOTS).toEqual([
			".decisions/",
			".claude/",
			".github/",
			"claude-plugins/",
			".fabrika.jsonc",
		]);
		for (const root of GOVERNANCE_ROOTS) {
			expect(touchesGovernanceRoot([`${root}deep/nested/file.txt`], GOVERNANCE_ROOTS)).toBe(true);
		}
	});

	it("is a prefix test, not a substring one", () => {
		expect(touchesGovernanceRoot(["docs/.github/notes.md"], GOVERNANCE_ROOTS)).toBe(false);
		expect(
			touchesGovernanceRoot(["packages/fabrika-cli/src/review/classes.ts"], GOVERNANCE_ROOTS),
		).toBe(false);
		expect(touchesGovernanceRoot([], GOVERNANCE_ROOTS)).toBe(false);
	});

	it("covers the decision corpus, which the harness flag deliberately does not", () => {
		expect(touchesGovernanceRoot([`${DECISIONS_ROOT}fabrika.md`], GOVERNANCE_ROOTS)).toBe(true);
		expect(partition([`${DECISIONS_ROOT}fabrika.md`]).harness).toBe(false);
	});
});

describe("isUiSurface", () => {
	it("raises the ui class over EVERY declared prefix, not just the first app's", () => {
		expect(isUiSurface("apps/desk/src/ui/Chat.tsx", UI_PREFIXES)).toBe(true);
		expect(isUiSurface("apps/site/src/App.tsx", UI_PREFIXES)).toBe(true);
	});

	it("keeps the test/spec exclusion — a rendered surface's own tests render nothing", () => {
		expect(isUiSurface("apps/site/src/App.test.tsx", UI_PREFIXES)).toBe(false);
		expect(isUiSurface("apps/desk/src/ui/Chat.spec.tsx", UI_PREFIXES)).toBe(false);
	});

	it("raises nothing on an empty prefix list — a repo declaring no surface has no rendered gate", () => {
		expect(isUiSurface("apps/site/src/App.tsx", [])).toBe(false);
	});

	it("derives the ui class off a Desk-only path list, which a compiled-in prefix could not", () => {
		const result = partitionWithUi(
			["apps/desk/src/ui/Chat.tsx", "apps/desk/src/ui/Chat.test.tsx"],
			GOVERNANCE_ROOTS,
			UI_PREFIXES,
		);
		expect(shipNamespacesOf(result)).toEqual(["review-code", "review-ui"]);
		expect(result.classes).toContainEqual({name: "ui", files: 1});
	});
});

describe("shipNamespacesOf", () => {
	// The one property that keeps this function from moving any existing PR's merge bar: for a diff
	// under no governance root the answer is byte-identical to the class-only derivation.
	it("leaves a diff outside every governance root requiring exactly its classes", () => {
		for (const files of [
			["src/a.ts"],
			["README.md", "src/a.ts"],
			["apps/site/src/App.tsx", "apps/site/src/App.test.tsx"],
			["skills/deploy-notes/SKILL.md"],
		]) {
			const result = partitionWithUi(files, GOVERNANCE_ROOTS, UI_PREFIXES);
			expect(result.governance).toBe(false);
			expect(shipNamespacesOf(result)).toEqual(result.classes.map((c) => `review-${c.name}`));
		}
	});

	it("appends governance — never replaces or reorders a review namespace", () => {
		const result = partitionWithUi(
			[
				"claude-plugins/fabrika/skills/ship/contract.md",
				"packages/fabrika-cli/src/ship/gate-verb.ts",
				"apps/site/src/App.tsx",
			],
			GOVERNANCE_ROOTS,
			UI_PREFIXES,
		);
		expect(shipNamespacesOf(result)).toEqual([
			"review-code",
			"review-skill",
			"review-ui",
			"governance",
		]);
	});

	it("derives governance off a decision-corpus edit no class map marks", () => {
		const result = partitionWithUi(
			[`${DECISIONS_ROOT}corpus-review.md`],
			GOVERNANCE_ROOTS,
			UI_PREFIXES,
		);
		expect(shipNamespacesOf(result)).toEqual(["review-doc", "governance"]);
	});

	it("only ever emits namespaces ship gate admits", () => {
		const result = partitionWithUi(
			[".github/workflows/ci.yml", "apps/site/src/App.tsx"],
			GOVERNANCE_ROOTS,
			UI_PREFIXES,
		);
		for (const namespace of shipNamespacesOf(result)) {
			expect(SHIP_NAMESPACES).toContain(namespace);
		}
	});
});

describe("linkedIssueOf", () => {
	it("takes the first closing keyword's issue", () => {
		expect(linkedIssueOf("does things\n\nFixes #4287\n")).toBe(4287);
		expect(linkedIssueOf("Closes #12\nFixes #99")).toBe(12);
		expect(linkedIssueOf("Resolved #7")).toBe(7);
	});

	it("answers null when the body carries no closing keyword", () => {
		expect(linkedIssueOf("relates to #4287")).toBeNull();
		expect(linkedIssueOf("Part of #4287")).toBeNull();
		expect(linkedIssueOf("")).toBeNull();
	});
});

describe("linkedIssuesOf", () => {
	/** The shape: the epic's own reference is last among N+1, and a scalar reader lost it. */
	it("reports every closing reference an epic tail body carries, epic included", () => {
		const tail = "Closes #6642. Closes #6643. Closes #6648. Closes #6629.";
		expect(linkedIssuesOf(tail)).toEqual([6642, 6643, 6648, 6629]);
		expect(linkedIssuesOf(tail)).toContain(6629);
	});

	it("agrees with the scalar reader on a single-reference body", () => {
		for (const body of ["does things\n\nFixes #4287\n", "Resolved #7", "relates to #4287", ""]) {
			expect(linkedIssuesOf(body)[0] ?? null).toBe(linkedIssueOf(body));
		}
		expect(linkedIssuesOf("does things\n\nFixes #4287\n")).toEqual([4287]);
		expect(linkedIssuesOf("Part of #4287")).toEqual([]);
	});

	it("names a repeated reference once", () => {
		expect(linkedIssuesOf("Closes #12\nFixes #12")).toEqual([12]);
	});
});

describe("issueRefsOf", () => {
	it("keeps the scalar reader's precedence, and reports the whole set of the winning kind", () => {
		expect(issueRefsOf("Closes #6642. Closes #6629.\n\nPart of #6000")).toEqual({
			kind: "fixes",
			numbers: [6642, 6629],
		});
		expect(issueRefsOf("does things\n\nPart of #5434\nPart of #5437\n")).toEqual({
			kind: "part-of",
			numbers: [5434, 5437],
		});
		expect(issueRefsOf("see #4000")).toEqual({kind: "none", numbers: []});
	});

	it("answers the scalar reader's kind and first number on every single-reference body", () => {
		for (const body of ["Fixes #4287", "Part of #4000", "part of: #12", "see #4000", ""]) {
			const ref = issueRefOf(body);
			const refs = issueRefsOf(body);
			expect(refs.kind).toBe(ref.kind);
			expect(refs.numbers[0] ?? null).toBe(ref.number);
		}
	});
});

describe("issueRefOf", () => {
	it("prefers a closing keyword, and keeps its kind distinct from a partial split", () => {
		expect(issueRefOf("Fixes #4287\n\nPart of #4000")).toEqual({kind: "fixes", number: 4287});
		expect(issueRefOf("Part of #4000")).toEqual({kind: "part-of", number: 4000});
	});

	it("reads the partial-split marker `build --partial` emits, in the shapes it emits it", () => {
		expect(issueRefOf("does things\n\nPart of #5434\nPart of #5437\n")).toEqual({
			kind: "part-of",
			number: 5434,
		});
		expect(issueRefOf("part of: #12")).toEqual({kind: "part-of", number: 12});
	});

	it("answers none for a body with neither marker", () => {
		expect(issueRefOf("see #4000")).toEqual({kind: "none", number: null});
		expect(issueRefOf("")).toEqual({kind: "none", number: null});
	});
});
