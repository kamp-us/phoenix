import {describe, expect, it} from "vitest";
import {containmentRefusal, type FacetVocabulary, ownsLabel, patternError} from "./containment.ts";

const KEY = "triageFacets";

const facet = (over: Partial<FacetVocabulary>): FacetVocabulary => ({
	name: "priority",
	owns: {_tag: "Pattern", source: "^p\\d+$"},
	values: ["p0", "p1", "p2"],
	...over,
});

describe("ownsLabel", () => {
	it("matches by pattern", () => {
		const owns = ownsLabel({_tag: "Pattern", source: "^type:"});
		expect(owns("type:bug")).toBe(true);
		expect(owns("p2")).toBe(false);
	});

	it("matches by membership, exactly — a set is not a prefix", () => {
		const owns = ownsLabel({_tag: "Set", labels: ["axis:pipeline-hardening"]});
		expect(owns("axis:pipeline-hardening")).toBe(true);
		expect(owns("axis:pipeline-hardening-2")).toBe(false);
	});
});

describe("patternError", () => {
	it("passes a usable pattern and names an unusable one", () => {
		expect(patternError("^p\\d+$")).toBeNull();
		expect(patternError("^p(")).not.toBeNull();
	});
});

describe("containmentRefusal", () => {
	it("passes a facet whose every value its pattern owns", () => {
		expect(containmentRefusal(KEY, [facet({})])).toBeNull();
	});

	it("passes a pattern wider than its values — that width is cleanup range, not a defect", () => {
		// `^p\d+$` owns `p3`, which no declared priority produces, so a priority retired from the
		// vocabulary is still reconciled away. Refusing this would refuse phoenix's own config.
		expect(containmentRefusal(KEY, [facet({values: ["p0"]})])).toBeNull();
	});

	it("refuses a declared value its pattern does not own, naming the facet and both sets", () => {
		const refusal = containmentRefusal(KEY, [facet({values: ["p0", "p1", "urgent"]})]);
		expect(refusal).toContain("`triageFacets` facet `priority`");
		expect(refusal).toContain("urgent");
		expect(refusal).toContain("owns=/^p\\d+$/");
		expect(refusal).toContain("values=[p0, p1, urgent]");
	});

	it("refuses a type facet whose pattern matches labels no declared type produces", () => {
		const refusal = containmentRefusal(KEY, [
			facet({name: "type", owns: {_tag: "Pattern", source: "^kind:"}, values: ["type:bug"]}),
		]);
		expect(refusal).toContain("facet `type`");
		expect(refusal).toContain("type:bug");
		expect(refusal).toContain("owns=/^kind:/");
	});

	it("refuses an enumerated facet owning a label outside its values", () => {
		const refusal = containmentRefusal(KEY, [
			facet({
				name: "lane",
				owns: {_tag: "Set", labels: ["wayfinder:backlog", "axis:dead"]},
				values: ["wayfinder:backlog"],
			}),
		]);
		expect(refusal).toContain("facet `lane`");
		expect(refusal).toContain("axis:dead");
		expect(refusal).toContain("owns=[wayfinder:backlog, axis:dead]");
		expect(refusal).toContain("values=[wayfinder:backlog]");
	});

	it("passes an enumerated facet that owns exactly its values", () => {
		const owns = {_tag: "Set", labels: ["wayfinder:backlog"]} as const;
		expect(
			containmentRefusal(KEY, [facet({name: "lane", owns, values: ["wayfinder:backlog"]})]),
		).toBeNull();
	});

	it("reports every violating facet, so three bad rows are not three round-trips", () => {
		const refusal = containmentRefusal(KEY, [
			facet({values: ["urgent"]}),
			facet({name: "type", owns: {_tag: "Pattern", source: "^kind:"}, values: ["type:bug"]}),
		]);
		expect(refusal).toContain("facet `priority`");
		expect(refusal).toContain("facet `type`");
	});
});
