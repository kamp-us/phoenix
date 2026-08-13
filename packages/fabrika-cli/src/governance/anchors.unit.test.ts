import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {
	anchorBlocksIn,
	anchorsIn,
	filesInDiff,
	isGuardBearing,
	mergeHits,
	scanAnchorBlocks,
	scanAnchors,
} from "./anchors.ts";

const GOVERNANCE_SKILL = "claude-plugins/fabrika/skills/governance/SKILL.md";

const diff = (...lines: ReadonlyArray<string>): string => `${lines.join("\n")}\n`;

const file = (path: string): ReadonlyArray<string> => [
	`diff --git a/${path} b/${path}`,
	`--- a/${path}`,
	`+++ b/${path}`,
	"@@ -10,3 +10,3 @@",
];

describe("scanAnchors", () => {
	it("reports an anchor present on a removed line and on no added line as `removed`", () => {
		const hits = scanAnchors(
			diff(
				...file("skills/review/SKILL.md"),
				"-<!-- anchor: SHA-BOUND --> the verdict names its head",
				" tail",
			),
		);
		expect(hits).toEqual([
			{kind: "removed", name: "SHA-BOUND", file: "skills/review/SKILL.md", line: 10},
		]);
	});

	it("reports an anchor on both sides with different following text as `modified`", () => {
		const hits = scanAnchors(
			diff(
				...file("skills/ship/SKILL.md"),
				"-<!-- anchor: SHA-BOUND --> the verdict names its head",
				"+<!-- anchor: SHA-BOUND --> the verdict may name a head",
			),
		);
		expect(hits).toEqual([
			{kind: "modified", name: "SHA-BOUND", file: "skills/ship/SKILL.md", line: 10},
		]);
	});

	it("reports NOTHING for an anchor that only moved — a reflow is not a weakening", () => {
		expect(
			scanAnchors(
				diff(
					...file("skills/ship/SKILL.md"),
					"-<!-- anchor: SHA-BOUND --> the verdict names its head",
					"+<!-- anchor: SHA-BOUND --> the verdict names its head",
				),
			),
		).toEqual([]);
	});

	it("keeps each file's anchors to that file — a name in two files is two questions", () => {
		const hits = scanAnchors(
			diff(
				...file("a.md"),
				"-<!-- anchor: G --> one",
				...file("b.md"),
				"-<!-- anchor: G --> two",
				"+<!-- anchor: G --> two",
			),
		);
		expect(hits).toEqual([{kind: "removed", name: "G", file: "a.md", line: 10}]);
	});

	it("reports NO phantom hit when the edited line only DESCRIBES the tag inside backticks", () => {
		expect(
			scanAnchors(
				diff(
					...file("skills/governance/SKILL.md"),
					"-`guards` reports the `<!-- anchor: NAME -->` tags skills carry",
					"+`guards` reports the `<!-- anchor: NAME -->` tags a skill carries",
				),
			),
		).toEqual([]);
	});

	it("finds nothing in a diff that carries no anchor at all", () => {
		expect(scanAnchors(diff(...file("src/cart.ts"), "-const a = 1;", "+const a = 2;"))).toEqual([]);
	});
});

/**
 * The live shape of the defect, taken from the merged PR #5501: an anchored claim whose continuation
 * line was reworded while the anchor's own line stayed byte-identical, so no `+`/`-` line in that
 * 98-file diff carried an anchor tag at all.
 */
const PACKED_BRANCH = (checkout: string): string =>
	[
		"<!-- anchor: READ-DERIVES-AGAINST-THE-PACKED-BRANCH --> **`read` re-derives rows 3–10 against",
		"the pack's own `git.branch`, never against the successor's `HEAD`.** A successor is by",
		`construction a different checkout — usually ${checkout} sitting on the default branch — so`,
		"deriving `git.head` from `HEAD` would report the successor's own location as drift.",
		"",
		"**The compared set is therefore sixteen of the nineteen, not all of them.**",
		"",
	].join("\n");

describe("anchorBlocksIn", () => {
	it("carries the anchor's continuation lines, which is the text the same-line scan never read", () => {
		expect(anchorBlocksIn("<!-- anchor: G --> a claim\nthat wraps here\n\nunrelated\n")).toEqual([
			{name: "G", line: 1, text: "a claim that wraps here"},
		]);
	});

	it("ends a block at the next anchor, so one paragraph never answers for another", () => {
		expect(anchorBlocksIn("<!-- anchor: A --> one\n<!-- anchor: B --> two\n")).toEqual([
			{name: "A", line: 1, text: "one"},
			{name: "B", line: 2, text: "two"},
		]);
	});

	it("ends a block at a heading, a new list item and a fence — the units a paragraph cannot span", () => {
		expect(anchorBlocksIn("- <!-- anchor: H --> a claim\n- a sibling bullet\n")).toEqual([
			{name: "H", line: 1, text: "a claim"},
		]);
		expect(anchorBlocksIn("<!-- anchor: H --> a claim\n## Next\n")).toEqual([
			{name: "H", line: 1, text: "a claim"},
		]);
		expect(anchorBlocksIn("<!-- anchor: H --> a claim\n```sh\nrm -rf\n```\n")).toEqual([
			{name: "H", line: 1, text: "a claim"},
		]);
	});

	it("mints NO block for a tag inside backticks — the fence holds over the widened unit", () => {
		expect(
			anchorBlocksIn("the `<!-- anchor: NAME -->` tags skills carry\nand more prose\n"),
		).toEqual([]);
	});

	it("does not let a backticked tag CUT a block short — masking decides anchors, not content", () => {
		expect(
			anchorBlocksIn("<!-- anchor: G --> a claim\nwritten as `<!-- anchor: NAME -->` here\n"),
		).toEqual([{name: "G", line: 1, text: "a claim written as `<!-- anchor: NAME -->` here"}]);
	});
});

describe("scanAnchorBlocks", () => {
	it("reports the PR #5501 shape: an anchored paragraph reworded below an untouched anchor line", () => {
		expect(
			scanAnchorBlocks(
				"contract.md",
				PACKED_BRANCH("a fresh worktree"),
				PACKED_BRANCH("a fresh clone"),
			),
		).toEqual([
			{
				kind: "modified",
				name: "READ-DERIVES-AGAINST-THE-PACKED-BRANCH",
				file: "contract.md",
				line: 1,
			},
		]);
	});

	it("reports NOTHING for a block that only moved — the anti-noise property, at block scale", () => {
		expect(
			scanAnchorBlocks(
				"contract.md",
				`# a doc\n\n${PACKED_BRANCH("a fresh worktree")}`,
				`# a doc\n\nprose added above\n\n${PACKED_BRANCH("a fresh worktree")}`,
			),
		).toEqual([]);
	});

	it("reports NOTHING for a pure re-wrap — a markdown line break is not a weakened guarantee", () => {
		expect(
			scanAnchorBlocks(
				"a.md",
				"<!-- anchor: G --> a claim that\nwraps here\n",
				"<!-- anchor: G --> a claim\nthat wraps here\n",
			),
		).toEqual([]);
	});

	it("reports NOTHING when a bullet BELOW an anchored bullet changes — blocks stop at the sibling", () => {
		expect(
			scanAnchorBlocks(
				"a.md",
				"- <!-- anchor: G --> a claim\n- an unanchored sibling\n",
				"- <!-- anchor: G --> a claim\n- a reworded sibling\n",
			),
		).toEqual([]);
	});

	it("reports an anchor absent from the later bytes as `removed`, at the line it sat on", () => {
		expect(scanAnchorBlocks("a.md", "x\n<!-- anchor: G --> a claim\n", "x\nplain prose\n")).toEqual(
			[{kind: "removed", name: "G", file: "a.md", line: 2}],
		);
	});

	it("pairs a repeated NAME by occurrence — two uses are two questions, not one", () => {
		expect(
			scanAnchorBlocks(
				"a.md",
				"<!-- anchor: G --> one\n\n<!-- anchor: G --> two\n",
				"<!-- anchor: G --> one\n\n<!-- anchor: G --> rewritten\n",
			),
		).toEqual([{kind: "modified", name: "G", file: "a.md", line: 3}]);
	});

	it("reports NOTHING when an anchor is added — a new guarantee is not a moved one", () => {
		expect(scanAnchorBlocks("a.md", "prose\n", "<!-- anchor: G --> a claim\n")).toEqual([]);
	});
});

describe("mergeHits", () => {
	const walk = {kind: "modified", name: "G", file: "a.md", line: 12} as const;
	const block = {kind: "modified", name: "G", file: "a.md", line: 40} as const;

	it("keeps one hit per file and NAME, with the first list's line", () => {
		expect(mergeHits([walk], [block])).toEqual([walk]);
	});

	it("keeps a same-named anchor in another file — a name in two files is two questions", () => {
		expect(mergeHits([walk], [{...block, file: "b.md"}])).toEqual([walk, {...block, file: "b.md"}]);
	});

	it("carries a block-only hit through — the case the diff walk structurally cannot see", () => {
		expect(mergeHits([], [block])).toEqual([block]);
	});
});

describe("anchorsIn", () => {
	it("counts the anchors a file's bytes carry", () => {
		expect(anchorsIn("<!-- anchor: A -->\ntext\n<!-- anchor: B --> more\n")).toBe(2);
	});

	it("counts none in a file with no anchor, which is the `no-anchors-in-reach` floor", () => {
		expect(anchorsIn("# a doc\n\nprose\n")).toBe(0);
	});

	it("does NOT count a tag inside backticks — a skill documenting the pattern is not an anchor", () => {
		expect(anchorsIn("the `<!-- anchor: NAME -->` tags skills carry\n")).toBe(0);
	});

	it("counts an anchor after a bullet and after a heading — position is not the discriminator", () => {
		expect(anchorsIn("- <!-- anchor: H1 --> a claim\n## Open <!-- anchor: Q1 -->\n")).toBe(2);
	});

	it("counts the governance skill's own eleven anchors, not the twelve a raw scan sees", () => {
		const skill = readFileSync(
			fileURLToPath(new URL(`../../../../${GOVERNANCE_SKILL}`, import.meta.url)),
			"utf8",
		);
		expect(anchorsIn(skill)).toBe(11);
	});
});

describe("filesInDiff", () => {
	it("counts the `diff --git` headers, which is the completeness proof's numerator", () => {
		expect(filesInDiff(diff(...file("a.md"), "-x", ...file("b.md"), "+y"))).toBe(2);
	});

	it("counts zero over an empty diff rather than throwing", () => {
		expect(filesInDiff("")).toBe(0);
	});
});

describe("isGuardBearing", () => {
	it("admits a file carrying an anchor", () => {
		expect(isGuardBearing("skills/review/SKILL.md", 3)).toBe(true);
	});

	it("admits a workflow whether or not it carries one — the enforcement layer is the clause", () => {
		expect(isGuardBearing(".github/workflows/ci.yml", 0)).toBe(true);
	});

	it("refuses everything else: `a file that looks important` is not a criterion", () => {
		expect(isGuardBearing("src/very/important.ts", 0)).toBe(false);
	});
});
