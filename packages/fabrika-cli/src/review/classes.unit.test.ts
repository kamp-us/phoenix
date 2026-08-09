import {describe, expect, it} from "vitest";
import {
	classOf,
	GOVERNANCE_ROOTS,
	linkedIssueOf,
	namespacesOf,
	partition,
	partitionWithUi,
	SHIP_CLASS_NAMES,
	SHIP_NAMESPACES,
	shipNamespacesOf,
	touchesGovernanceRoot,
} from "./classes.ts";

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
		expect(classOf(".decisions/0238-fabrika.md")).toBe("doc");
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
	it("fires on each of the four roots, at any depth", () => {
		expect(GOVERNANCE_ROOTS).toEqual([".decisions/", ".claude/", ".github/", "claude-plugins/"]);
		for (const root of GOVERNANCE_ROOTS) {
			expect(touchesGovernanceRoot([`${root}deep/nested/file.txt`])).toBe(true);
		}
	});

	it("is a prefix test, not a substring one", () => {
		expect(touchesGovernanceRoot(["docs/.github/notes.md"])).toBe(false);
		expect(touchesGovernanceRoot(["packages/fabrika-cli/src/review/classes.ts"])).toBe(false);
		expect(touchesGovernanceRoot([])).toBe(false);
	});

	it("covers the decision corpus, which the harness flag deliberately does not", () => {
		expect(touchesGovernanceRoot([".decisions/0238-fabrika.md"])).toBe(true);
		expect(partition([".decisions/0238-fabrika.md"]).harness).toBe(false);
	});
});

describe("shipNamespacesOf", () => {
	// The one property that keeps this function from moving any existing PR's merge bar: for a diff
	// under no governance root the answer is byte-identical to the class-only derivation (#5199).
	it("leaves a diff outside every governance root requiring exactly its classes", () => {
		for (const files of [
			["src/a.ts"],
			["README.md", "src/a.ts"],
			["apps/web/src/App.tsx", "apps/web/src/App.test.tsx"],
			["skills/deploy-notes/SKILL.md"],
		]) {
			const result = partitionWithUi(files);
			expect(result.governance).toBe(false);
			expect(shipNamespacesOf(result)).toEqual(result.classes.map((c) => `review-${c.name}`));
		}
	});

	it("appends governance — never replaces or reorders a review namespace", () => {
		const result = partitionWithUi([
			"claude-plugins/fabrika/skills/ship/contract.md",
			"packages/fabrika-cli/src/ship/gate-verb.ts",
			"apps/web/src/App.tsx",
		]);
		expect(shipNamespacesOf(result)).toEqual([
			"review-code",
			"review-skill",
			"review-ui",
			"governance",
		]);
	});

	it("derives governance off a decision-corpus edit no class map marks", () => {
		const result = partitionWithUi([".decisions/0244-corpus-review.md"]);
		expect(shipNamespacesOf(result)).toEqual(["review-doc", "governance"]);
	});

	it("only ever emits namespaces ship gate admits", () => {
		const result = partitionWithUi([".github/workflows/ci.yml", "apps/web/src/App.tsx"]);
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
