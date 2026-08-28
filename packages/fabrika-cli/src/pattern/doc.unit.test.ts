import {describe, expect, it} from "vitest";
import {
	ANCHOR_DECLARATION,
	anchorLine,
	docTemplate,
	isKebabCase,
	splitAnchorToken,
	titleFrom,
} from "./doc.ts";

describe("isKebabCase", () => {
	it("admits lowercase letters, digits and single hyphens", () => {
		for (const slug of ["worker-queue-retry", "fate", "d1-batch-2"]) {
			expect(isKebabCase(slug)).toBe(true);
		}
	});

	it("refuses upper case, doubled hyphens and edge hyphens", () => {
		for (const slug of ["Worker-Queue", "a--b", "-a", "a-", "a_b", "a b", ""]) {
			expect(isKebabCase(slug)).toBe(false);
		}
	});
});

describe("titleFrom", () => {
	it("upper-cases only the first character and special-cases nothing else", () => {
		expect(titleFrom("worker-queue-retry")).toBe("Worker queue retry");
		expect(titleFrom("fate-effect-server")).toBe("Fate effect server");
		expect(titleFrom("d1-batch")).toBe("D1 batch");
	});
});

describe("splitAnchorToken", () => {
	// Splitting at the LAST `@` is what makes a scoped package work; a first-`@` split yields an
	// empty package name and would make every scoped anchor malformed.
	it("splits a scoped package at its last @", () => {
		expect(splitAnchorToken("@nkzw/fate@1.3.1")).toEqual({pkg: "@nkzw/fate", version: "1.3.1"});
	});

	it("splits an unscoped package", () => {
		expect(splitAnchorToken("acme-queue@4.2.0")).toEqual({pkg: "acme-queue", version: "4.2.0"});
	});

	it("refuses a token with no @, or with an empty half", () => {
		for (const token of ["acme-queue", "@scope/only", "acme-queue@", ""]) {
			expect(splitAnchorToken(token)).toBeNull();
		}
	});
});

describe("the anchor line is composed and parsed from one home", () => {
	it("round-trips every token the writer accepts", () => {
		for (const token of ["acme-queue@4.2.0", "@nkzw/fate@1.3.1"]) {
			expect(ANCHOR_DECLARATION.exec(anchorLine(token))?.[1]).toBe(token);
		}
	});
});

describe("docTemplate", () => {
	it("writes the current-scope scaffold without --anchor", () => {
		const text = docTemplate("Worker queue retry", null);
		expect(text.startsWith("# Worker queue retry\n\n")).toBe(true);
		expect(text).toContain("## The shape");
		expect(text).toContain("## When this applies");
		expect(text).toContain("## Why it is not obvious");
		expect(text).not.toContain("Derived from");
		expect(text).not.toContain("two or more places");
	});

	it("writes intended scope and a binding-decision citation for prospective patterns", () => {
		const text = docTemplate(
			"Worker queue retry",
			null,
			"https://github.com/acme/repo/issues/1#issuecomment-1",
		);
		expect(text).toContain("## Prospective scope");
		expect(text).toContain("Do not claim current call sites that do not exist");
		expect(text).toContain(
			"[the binding decision](https://github.com/acme/repo/issues/1#issuecomment-1)",
		);
	});

	it("appends the anchor line in the exact bytes pattern anchor parses", () => {
		const text = docTemplate("Worker queue retry", "acme-queue@4.2.0");
		const line = text.trimEnd().split("\n").at(-1) ?? "";
		expect(line).toBe("> Derived from `acme-queue@4.2.0` — re-verify on pin bump.");
		expect(ANCHOR_DECLARATION.test(line)).toBe(true);
	});
});
