import {describe, expect, it} from "vitest";
import {changedLines, filesInDiff, tierMHits} from "./diff.ts";

const DIFF = `diff --git a/src/cart.ts b/src/cart.ts
index 0b1c2d3..a1b2c3d 100644
--- a/src/cart.ts
+++ b/src/cart.ts
@@ -10,3 +10,4 @@ export const total = () => {
 	const items = read();
+	// biome-ignore lint/suspicious/noExplicitAny: not now
 	return items.length;
 };
diff --git a/src/cart.test.ts b/src/cart.test.ts
index 1111111..2222222 100644
--- a/src/cart.test.ts
+++ b/src/cart.test.ts
@@ -12,4 +12,3 @@ describe("cart", () => {
 	it("renders", () => {
-		expect(renderTotal(10)).toBe("10.00");
 	});
 });
`;

/**
 * Real `git diff` output, copied verbatim from a throwaway repo on git's defaults — a backslash in
 * the name (quoted whatever `core.quotePath` says) and two Turkish names (quoted because
 * `core.quotePath` is on). Every `\\` below is one literal backslash in the diff bytes.
 */
const QUOTED_DIFF = `diff --git "a/ka\\\\\\303\\247ak.ts" "b/ka\\\\\\303\\247ak.ts"
index 422c2b7..0f7bc76 100644
--- "a/ka\\\\\\303\\247ak.ts"
+++ "b/ka\\\\\\303\\247ak.ts"
@@ -1,2 +1,2 @@
 a
-b
+c
diff --git a/plain.ts b/plain.ts
index b6ab9e6..187a501 100644
--- a/plain.ts
+++ b/plain.ts
@@ -1,2 +1,3 @@
 const items = read();
+// biome-ignore lint/suspicious/noExplicitAny: not now
 return items.length;
diff --git "a/s\\303\\266zl\\303\\274k-ba\\305\\237l\\304\\261k.test.ts" "b/s\\303\\266zl\\303\\274k-ba\\305\\237l\\304\\261k.test.ts"
index fce2e4b..09058a9 100644
--- "a/s\\303\\266zl\\303\\274k-ba\\305\\237l\\304\\261k.test.ts"
+++ "b/s\\303\\266zl\\303\\274k-ba\\305\\237l\\304\\261k.test.ts"
@@ -1,3 +1,2 @@
 it("x", () => {
-	expect(sozluk(10)).toBe("on");
 });
`;

describe("filesInDiff", () => {
	it("counts one per `diff --git` header — the numerator of the completeness proof", () => {
		expect(filesInDiff(DIFF)).toBe(2);
		expect(filesInDiff("")).toBe(0);
	});

	it("counts a git-quoted header, so a non-ASCII path no longer forces a false exit 13", () => {
		expect(filesInDiff(QUOTED_DIFF)).toBe(3);
	});
});

describe("changedLines", () => {
	it("numbers an added line in the new file and a removed one in the old", () => {
		const lines = changedLines(DIFF);
		expect(lines).toContainEqual({
			file: "src/cart.ts",
			line: 11,
			kind: "added",
			text: "	// biome-ignore lint/suspicious/noExplicitAny: not now",
		});
		expect(lines).toContainEqual({
			file: "src/cart.test.ts",
			line: 13,
			kind: "removed",
			text: '		expect(renderTotal(10)).toBe("10.00");',
		});
	});

	it("reads nothing above the first hunk — the `---`/`+++` lines carry no line number", () => {
		expect(changedLines(DIFF).some((line) => line.text.startsWith("+ b/"))).toBe(false);
		expect(changedLines(DIFF).filter((line) => line.file === "").length).toBe(0);
	});

	it("reports a deletion under the path it had", () => {
		const deleted = `diff --git a/gone.test.ts b/dev/null
--- a/gone.test.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-expect(1).toBe(1);
-const x = 1;
`;
		expect(changedLines(deleted)[0]?.file).toBe("dev/null");
	});

	it("gives a quoted-path file its own name and line numbers, unescaped back to the real path", () => {
		const lines = changedLines(QUOTED_DIFF);
		expect(lines).toContainEqual({
			file: "sözlük-başlık.test.ts",
			line: 2,
			kind: "removed",
			text: '	expect(sozluk(10)).toBe("on");',
		});
		expect(lines).toContainEqual({
			file: "ka\\çak.ts",
			line: 2,
			kind: "added",
			text: "c",
		});
	});

	it("emits nothing for a quoted header's own `---`/`+++` lines", () => {
		const lines = changedLines(QUOTED_DIFF);
		expect(lines.filter((line) => line.text.startsWith('-- "'))).toEqual([]);
		expect(lines.filter((line) => line.text.startsWith('++ "'))).toEqual([]);
		expect(lines.filter((line) => line.file === "")).toEqual([]);
	});

	it("reads a header whose sides quote independently — a rename to a non-ASCII name", () => {
		const renamed = `diff --git a/plain.ts "b/yeni-\\303\\274nl\\303\\274.ts"
--- a/plain.ts
+++ "b/yeni-\\303\\274nl\\303\\274.ts"
@@ -1,1 +1,1 @@
-a
+b
`;
		expect(changedLines(renamed)[0]?.file).toBe("yeni-ünlü.ts");
	});
});

describe("tierMHits", () => {
	it("finds an added suppression and a removed assertion in a test file", () => {
		expect(tierMHits(DIFF)).toEqual([
			{
				kind: "suppression",
				file: "src/cart.ts",
				line: 11,
				token: "biome-ignore",
			},
			{
				kind: "removed-assertion",
				file: "src/cart.test.ts",
				line: 13,
				token: 'expect(renderTotal(10)).toBe("10.00");',
			},
		]);
	});

	it("reports a removed assertion in a test file whose name is non-ASCII", () => {
		expect(tierMHits(QUOTED_DIFF)).toEqual([
			{
				kind: "suppression",
				file: "plain.ts",
				line: 2,
				token: "biome-ignore",
			},
			{
				kind: "removed-assertion",
				file: "sözlük-başlık.test.ts",
				line: 2,
				token: 'expect(sozluk(10)).toBe("on");',
			},
		]);
	});

	it("reports a removed assertion in a test file whose name carries an escaped quote", () => {
		const diff = `diff --git "a/qu\\"ote.test.ts" "b/qu\\"ote.test.ts"
@@ -1,2 +1,1 @@
 a
-expect(x).toBe(1);
`;
		expect(tierMHits(diff)).toEqual([
			{
				kind: "removed-assertion",
				file: 'qu"ote.test.ts',
				line: 2,
				token: "expect(x).toBe(1);",
			},
		]);
	});

	it("finds each of the four suppression tokens the contract enumerates", () => {
		const suppressions = ["biome-ignore", "@ts-expect-error", "test.skip", ".only"];
		for (const token of suppressions) {
			const diff = `diff --git a/a.ts b/a.ts\n@@ -1,1 +1,2 @@\n a\n+${token} here\n`;
			expect(tierMHits(diff).map((hit) => hit.token)).toContain(token);
		}
	});

	it("does not report a removed assertion outside a test file", () => {
		const diff = `diff --git a/src/app.ts b/src/app.ts\n@@ -1,2 +1,1 @@\n a\n-expect(x).toBe(1);\n`;
		expect(tierMHits(diff)).toEqual([]);
	});

	it("finds a removed assertion in each spelling the repo's two runners write", () => {
		const spellings = [
			"assert(ok);",
			"expect(x).toBe(1);",
			"assert.isTrue(ok);",
			"assert.isFalse(ok);",
			"assert.strictEqual(a, b);",
			"assert.deepStrictEqual(a, b);",
			'expect.fail("nope");',
		];
		for (const line of spellings) {
			const diff = `diff --git a/a.test.ts b/a.test.ts\n@@ -1,2 +1,1 @@\n a\n-\t${line}\n`;
			expect(tierMHits(diff)).toEqual([
				{kind: "removed-assertion", file: "a.test.ts", line: 2, token: line},
			]);
		}
	});

	it("reports the removed assertion PR #5730 printed None. beside", () => {
		const line = 'assert.isTrue(isSelfExempt(".claude/skills/triage/SKILL.md"));';
		const file = "packages/demo-cli/src/tools/leak-guard/leak-guard.unit.test.ts";
		const diff = `diff --git a/${file} b/${file}\n@@ -268,2 +268,1 @@\n \tit("exempts a skill", () => {\n-\t\t${line}\n`;
		expect(tierMHits(diff)).toEqual([{kind: "removed-assertion", file, line: 269, token: line}]);
	});

	it("does not report a removed non-assertion line in a test file", () => {
		const diff = `diff --git a/a.test.ts b/a.test.ts\n@@ -1,2 +1,1 @@\n a\n-\tconst rows = collect();\n`;
		expect(tierMHits(diff)).toEqual([]);
	});

	it("does not report an identifier that merely contains expect or assert", () => {
		for (const line of ["assertions.push(1);", "expectation(x);", "myassert(x);", "reexpect(x);"]) {
			const diff = `diff --git a/a.test.ts b/a.test.ts\n@@ -1,2 +1,1 @@\n a\n-\t${line}\n`;
			expect(tierMHits(diff)).toEqual([]);
		}
	});

	it("does not report a suppression that was REMOVED — only what the diff adds", () => {
		const diff = `diff --git a/a.ts b/a.ts\n@@ -1,2 +1,1 @@\n a\n-// biome-ignore lint: gone\n`;
		expect(tierMHits(diff)).toEqual([]);
	});
});
