import {describe, expect, it} from "vitest";
import type {IssueVerdict} from "./pipeline.ts";
import {summarizeVerdict, verdictLabel} from "./verdict.ts";

const v = (over: Partial<IssueVerdict>): IssueVerdict => ({
	prNumber: 1,
	prUrl: "https://github.com/kamp-us/phoenix/pull/1",
	code: null,
	doc: null,
	...over,
});

describe("summarizeVerdict", () => {
	it("is none when there is no linked PR", () => {
		expect(summarizeVerdict(null)).toBe("none");
		expect(summarizeVerdict(undefined)).toBe("none");
	});

	it("is awaiting for an open PR with no marker in either namespace", () => {
		expect(summarizeVerdict(v({code: null, doc: null}))).toBe("awaiting");
	});

	it("is pass for a code PASS", () => {
		expect(summarizeVerdict(v({code: "PASS"}))).toBe("pass");
	});

	it("is pass for a doc PASS", () => {
		expect(summarizeVerdict(v({doc: "PASS"}))).toBe("pass");
	});

	it("is fail for a code FAIL", () => {
		expect(summarizeVerdict(v({code: "FAIL"}))).toBe("fail");
	});

	it("lets FAIL dominate a mixed code-PASS/doc-FAIL PR", () => {
		expect(summarizeVerdict(v({code: "PASS", doc: "FAIL"}))).toBe("fail");
	});
});

describe("verdictLabel", () => {
	it("maps each summary to its label, none → null", () => {
		expect(verdictLabel("pass")).toBe("PASS");
		expect(verdictLabel("fail")).toBe("FAIL");
		expect(verdictLabel("awaiting")).toBe("awaiting review");
		expect(verdictLabel("none")).toBeNull();
	});
});
