import {describe, expect, it} from "vitest";
import {
	conforms,
	DEFAULT_RETRY_CAP,
	decide,
	type OutputSchema,
	renderFailureMessage,
	renderSchemaSection,
	validate,
} from "./structured-output-guard.ts";

const SCHEMA: OutputSchema = {
	required: ["issue", "prUrl", "wiringApplied", "backedOff", "notes"],
};

describe("validate — the full field diff", () => {
	it("a fully-conforming payload has no missing and all present", () => {
		const diff = validate(
			{issue: 742, prUrl: "u", wiringApplied: true, backedOff: false, notes: "n"},
			SCHEMA,
		);
		expect(diff.missing).toEqual([]);
		expect(diff.present).toEqual(SCHEMA.required);
		expect(diff.extra).toEqual([]);
		expect(conforms(diff)).toBe(true);
	});

	it("names EVERY missing field and EVERY present field, not just the first", () => {
		const diff = validate({issue: 742, notes: "n"}, SCHEMA);
		expect(diff.missing).toEqual(["prUrl", "wiringApplied", "backedOff"]);
		expect(diff.present).toEqual(["issue", "notes"]);
		expect(conforms(diff)).toBe(false);
	});

	it("treats null/undefined as missing but false/0/'' as present (make-invalid-states explicit)", () => {
		const diff = validate(
			{issue: 0, prUrl: "", wiringApplied: false, backedOff: null, notes: undefined},
			SCHEMA,
		);
		expect(diff.present).toEqual(["issue", "prUrl", "wiringApplied"]);
		expect(diff.missing).toEqual(["backedOff", "notes"]);
	});

	it("surfaces extra keys (not in required ∪ optional) without failing", () => {
		const schema: OutputSchema = {required: ["a"], optional: ["b"]};
		const diff = validate({a: 1, b: 2, c: 3}, schema);
		expect(diff.extra).toEqual(["c"]);
		expect(conforms(diff)).toBe(true);
	});
});

describe("decide — the retry core (the three AC cases)", () => {
	const ok = {issue: 742, prUrl: "u", wiringApplied: true, backedOff: false, notes: "n"};
	const bad = {issue: 742, notes: "n"};

	it("PASS: a conforming payload accepts on the first try (retryCount 0)", () => {
		const d = decide(ok, SCHEMA, 0);
		expect(d.kind).toBe("accept");
		if (d.kind === "accept") expect(d.diff.missing).toEqual([]);
	});

	it("RETRY: a miss with budget remaining retries, carrying the rich message", () => {
		const d = decide(bad, SCHEMA, 0);
		expect(d.kind).toBe("retry");
		if (d.kind === "retry") {
			expect(d.retryNumber).toBe(1);
			expect(d.cap).toBe(DEFAULT_RETRY_CAP);
			expect(d.message).toContain("missing");
			expect(d.diff.missing).toEqual(["prUrl", "wiringApplied", "backedOff"]);
		}
	});

	it("RETRY then PASS: after one retry, a now-conforming payload accepts", () => {
		const first = decide(bad, SCHEMA, 0);
		expect(first.kind).toBe("retry");
		const second = decide(ok, SCHEMA, 1);
		expect(second.kind).toBe("accept");
	});

	it("EXHAUST: a miss at the cap (retryCount === cap) fails, not retries", () => {
		const d = decide(bad, SCHEMA, DEFAULT_RETRY_CAP);
		expect(d.kind).toBe("fail");
		if (d.kind === "fail") {
			expect(d.cap).toBe(DEFAULT_RETRY_CAP);
			expect(d.message).toContain("missing");
		}
	});

	it("EXHAUST: retries up to exactly 2 then fails (retry,retry,fail walk)", () => {
		expect(decide(bad, SCHEMA, 0).kind).toBe("retry");
		expect(decide(bad, SCHEMA, 1).kind).toBe("retry");
		expect(decide(bad, SCHEMA, 2).kind).toBe("fail");
	});

	it("honors a custom cap when supplied", () => {
		expect(decide(bad, SCHEMA, 0, {cap: 0}).kind).toBe("fail");
		expect(decide(bad, SCHEMA, 1, {cap: 5}).kind).toBe("retry");
	});
});

describe("renderFailureMessage — rich, not terse", () => {
	it("enumerates all missing AND all present fields plus a worked example", () => {
		const diff = validate({issue: 742, notes: "n"}, SCHEMA);
		const msg = renderFailureMessage(diff, SCHEMA, {
			issue: 742,
			prUrl: "https://...",
			wiringApplied: true,
			backedOff: false,
			notes: "n",
		});
		expect(msg).toContain("prUrl");
		expect(msg).toContain("wiringApplied");
		expect(msg).toContain("backedOff");
		expect(msg).toContain("issue");
		expect(msg).toContain("notes");
		expect(msg).toContain("present");
		expect(msg).toContain("https://...");
	});

	it("falls back to a schema-derived example when none is given", () => {
		const diff = validate({}, {required: ["a", "b"]});
		const msg = renderFailureMessage(diff, {required: ["a", "b"]});
		expect(msg).toContain("<a>");
		expect(msg).toContain("<b>");
	});
});

describe("renderSchemaSection — schema-in-spawn-prompt", () => {
	it("embeds every required field and a filled conforming example", () => {
		const section = renderSchemaSection(SCHEMA, {
			issue: 742,
			prUrl: "u",
			wiringApplied: true,
			backedOff: false,
			notes: "n",
		});
		for (const f of SCHEMA.required) expect(section).toContain(f);
		expect(section).toContain("```json");
		expect(section).toContain(String(DEFAULT_RETRY_CAP));
	});

	it("lists optional fields when present", () => {
		const section = renderSchemaSection({required: ["a"], optional: ["b"]});
		expect(section).toContain("Optional fields");
		expect(section).toContain("b");
	});
});
