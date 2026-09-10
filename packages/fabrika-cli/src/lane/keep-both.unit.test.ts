/**
 * The one content judgment the replay makes: an append each is kept both ways, and everything else
 * is refused rather than guessed at.
 */
import {describe, expect, it} from "vitest";
import {resolveKeepBoth} from "./keep-both.ts";

/** The collision the replay exists for: two children appending a row to one flag registry. */
const REGISTRY_APPEND = [
	"export const FLAGS = {",
	'\tassemblyRefresh: "off",',
	"<<<<<<< HEAD",
	'\tassemblyReplay: "off",',
	"||||||| parent of 1a2b3c4",
	"=======",
	'\tlaneConcurrencyCap: "4",',
	">>>>>>> 1a2b3c4 (feat: cap concurrent lanes)",
	"} as const;",
].join("\n");

describe("resolveKeepBoth", () => {
	it("keeps both appends where the base had nothing, tip above child", () => {
		const judged = resolveKeepBoth(REGISTRY_APPEND);

		expect(judged).toEqual({
			_tag: "KeepBoth",
			hunks: 1,
			text: [
				"export const FLAGS = {",
				'\tassemblyRefresh: "off",',
				'\tassemblyReplay: "off",',
				'\tlaneConcurrencyCap: "4",',
				"} as const;",
			].join("\n"),
		});
	});

	it("keeps every hunk of a file that collided twice", () => {
		const twice = [
			"<<<<<<< HEAD",
			"a",
			"||||||| base",
			"=======",
			"b",
			">>>>>>> child",
			"middle",
			"<<<<<<< HEAD",
			"c",
			"||||||| base",
			"=======",
			"d",
			">>>>>>> child",
		].join("\n");

		expect(resolveKeepBoth(twice)).toEqual({
			_tag: "KeepBoth",
			hunks: 2,
			text: ["a", "b", "middle", "c", "d"].join("\n"),
		});
	});

	it("refuses a hunk whose base carries lines — that is two sides editing one text", () => {
		const edited = [
			"<<<<<<< HEAD",
			"tip's wording",
			"||||||| base",
			"the original wording",
			"=======",
			"child's wording",
			">>>>>>> child",
		].join("\n");

		const judged = resolveKeepBoth(edited);
		expect(judged._tag).toBe("NotKeepBoth");
		if (judged._tag === "NotKeepBoth") expect(judged.reason).toContain("editing one text");
	});

	it("refuses a hunk with an empty side — keeping both would resurrect a deletion", () => {
		const deleted = ["<<<<<<< HEAD", "kept", "||||||| base", "=======", ">>>>>>> child"].join("\n");

		const judged = resolveKeepBoth(deleted);
		expect(judged._tag).toBe("NotKeepBoth");
		if (judged._tag === "NotKeepBoth") expect(judged.reason).toContain("empty side");
	});

	// Without `merge.conflictStyle=diff3` there is no base section to read, and a conflict whose base
	// nobody can see is indistinguishable from one whose base is non-empty.
	it("refuses a conflict written without a base section", () => {
		const twoWay = ["<<<<<<< HEAD", "a", "=======", "b", ">>>>>>> child"].join("\n");

		const judged = resolveKeepBoth(twoWay);
		expect(judged._tag).toBe("NotKeepBoth");
		if (judged._tag === "NotKeepBoth") expect(judged.reason).toContain("base section");
	});

	it.each([
		["an unterminated block", ["<<<<<<< HEAD", "a", "||||||| base", "=======", "b"].join("\n")],
		["a block with no separator", ["<<<<<<< HEAD", "a", "||||||| base", "b"].join("\n")],
	])("refuses %s rather than resolving half of it", (_case, text) => {
		expect(resolveKeepBoth(text)._tag).toBe("NotKeepBoth");
	});

	it("refuses a file with no markers — a delete/modify or a binary collision", () => {
		const judged = resolveKeepBoth("plain text\nwith no conflict\n");
		expect(judged._tag).toBe("NotKeepBoth");
		if (judged._tag === "NotKeepBoth") expect(judged.reason).toContain("no conflict markers");
	});

	// A markdown setext heading underlines with `=`, and a run of `<` or `>` is ordinary prose. Only a
	// marker inside an opened block is read as one, so neither is mistaken for a conflict.
	it("reads a bare separator outside a block as the text it is", () => {
		expect(resolveKeepBoth("Heading\n=======\n\nbody")._tag).toBe("NotKeepBoth");
	});

	// The fail-open arm this refusal closes: `theirs` ends at the FIRST line matching `isEnd`, so a
	// child line shaped like one closes the hunk early, the real end marker falls through the outer
	// loop as ordinary text, and the caller stages a file carrying a live marker.
	it("refuses a hunk whose child side carries a line shaped like an end marker", () => {
		const forged = [
			"<<<<<<< HEAD",
			'\tassemblyReplay: "off",',
			"||||||| parent of 1a2b3c4",
			"=======",
			'\tlaneConcurrencyCap: "4",',
			">>>>>>> not really the end",
			'\tlaneConcurrencyWindow: "1h",',
			">>>>>>> 1a2b3c4 (feat: cap concurrent lanes)",
		].join("\n");

		const judged = resolveKeepBoth(forged);

		expect(judged._tag).toBe("NotKeepBoth");
		if (judged._tag === "NotKeepBoth")
			expect(judged.reason).toContain("still carries a conflict marker");
	});

	// The same leak through the base section: a base line shaped like `=======` closes it early, the
	// real separator lands inside `theirs`, and `base.length` reads zero so the rewrite check passes.
	it("refuses a hunk whose base carries a line shaped like the separator", () => {
		const forged = [
			"<<<<<<< HEAD",
			"ours",
			"||||||| parent of 1a2b3c4",
			"=======",
			"a base line",
			"=======",
			"theirs",
			">>>>>>> 1a2b3c4 (feat: something)",
		].join("\n");

		const judged = resolveKeepBoth(forged);

		expect(judged._tag).toBe("NotKeepBoth");
		if (judged._tag === "NotKeepBoth")
			expect(judged.reason).toContain("still carries a conflict marker");
	});

	it("keeps a hunk whose kept lines themselves look like prose separators", () => {
		const prose = [
			"<<<<<<< HEAD",
			"Heading",
			"||||||| base",
			"=======",
			"Another",
			">>>>>>> child",
		].join("\n");

		expect(resolveKeepBoth(prose)).toEqual({
			_tag: "KeepBoth",
			hunks: 1,
			text: "Heading\nAnother",
		});
	});
});
