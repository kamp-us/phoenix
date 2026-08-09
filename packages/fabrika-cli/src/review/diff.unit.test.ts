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

describe("filesInDiff", () => {
	it("counts one per `diff --git` header — the numerator of the completeness proof", () => {
		expect(filesInDiff(DIFF)).toBe(2);
		expect(filesInDiff("")).toBe(0);
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

	it("does not report a suppression that was REMOVED — only what the diff adds", () => {
		const diff = `diff --git a/a.ts b/a.ts\n@@ -1,2 +1,1 @@\n a\n-// biome-ignore lint: gone\n`;
		expect(tierMHits(diff)).toEqual([]);
	});
});
