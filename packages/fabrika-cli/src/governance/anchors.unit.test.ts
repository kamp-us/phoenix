import {describe, expect, it} from "vitest";
import {anchorsIn, filesInDiff, isGuardBearing, scanAnchors} from "./anchors.ts";

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

	it("finds nothing in a diff that carries no anchor at all", () => {
		expect(scanAnchors(diff(...file("src/cart.ts"), "-const a = 1;", "+const a = 2;"))).toEqual([]);
	});
});

describe("anchorsIn", () => {
	it("counts the anchors a file's bytes carry", () => {
		expect(anchorsIn("<!-- anchor: A -->\ntext\n<!-- anchor: B --> more\n")).toBe(2);
	});

	it("counts none in a file with no anchor, which is the `no-anchors-in-reach` floor", () => {
		expect(anchorsIn("# a doc\n\nprose\n")).toBe(0);
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
