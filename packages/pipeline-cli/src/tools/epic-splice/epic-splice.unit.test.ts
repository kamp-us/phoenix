/**
 * Unit tests for the `epic-splice` pure core (#3689): the epic-body splice extracted from
 * `plan-epic`'s inline Step-5 splice (#261). IO-free — no `gh` boundary. The headline invariants:
 * first-time APPEND vs re-plan in-place REPLACE, the heading-count corruption guards, and
 * byte-for-byte preservation of everything outside the replaced section (the brief especially).
 */
import {assert, describe, expect, it} from "@effect/vitest";
import {type SpliceOutcome, spliceEpicBody} from "./epic-splice.ts";

// A brief with deliberately fragile bytes: trailing whitespace, a backtick span, a blank line —
// exactly what a naive reconstruct-from-memory splice would "tidy" and thereby clobber (#261).
const BRIEF = "## Problem\n\nThe brief.  trailing spaces:   \nA `code` span and a — dash.\n\n";
const PLAN = "## Plan (plan-epic)\n\n### Product layer\n\nold plan prose.\n\n";
const DEPS = "## Dependencies\n\n### Phase 1\n- #1 — a\n- #2 — b\n";

const spliced = (o: SpliceOutcome): string => {
	assert.strictEqual(o._tag, "Spliced");
	return o._tag === "Spliced" ? o.body : "";
};

// Assert the outcome is a refusal and return its reason for an UNCONDITIONAL `expect` — so the
// reason check never hides behind an `if` branch that might not run (the silent-pass shape).
const corruptReason = (o: SpliceOutcome): string => {
	assert.strictEqual(o._tag, "Corrupt");
	return o._tag === "Corrupt" ? o.reason : "";
};

describe("first-time plan — APPEND (no `## Dependencies` heading yet)", () => {
	const body = BRIEF + PLAN;
	const deps = "## Dependencies\n\n### Phase 1\n- #10 — x\n";

	it("appends the deps block to the verbatim live body", () => {
		const out = spliceEpicBody({body, deps, plan: null});
		assert.strictEqual(out._tag, "Spliced");
		if (out._tag !== "Spliced") return;
		expect(out.mode).toBe("append");
		expect(out.body).toBe(body + deps);
	});

	it("preserves the brief and plan byte-for-byte", () => {
		const out = spliced(spliceEpicBody({body, deps, plan: null}));
		expect(out.startsWith(BRIEF + PLAN)).toBe(true);
	});
});

describe("re-plan of deps only — REPLACE the pinned section in place (plan unchanged)", () => {
	const body = BRIEF + PLAN + DEPS;
	const newDeps = "## Dependencies\n\n### Phase 1\n- #99 — fresh\n";

	it("cuts from the single `## Dependencies` heading to EOF and re-appends the fresh block", () => {
		const out = spliceEpicBody({body, deps: newDeps, plan: null});
		assert.strictEqual(out._tag, "Spliced");
		if (out._tag !== "Spliced") return;
		expect(out.mode).toBe("replace");
		expect(out.body).toBe(BRIEF + PLAN + newDeps);
	});

	it("preserves the brief and the unchanged plan section verbatim", () => {
		const out = spliced(spliceEpicBody({body, deps: newDeps, plan: null}));
		expect(out.startsWith(BRIEF + PLAN)).toBe(true);
		// the old deps line is gone, the fresh one is present
		expect(out).not.toContain("- #1 — a");
		expect(out).toContain("- #99 — fresh");
	});
});

describe("re-plan of both sections — splice plan AND deps in place", () => {
	const MIDDLE = "## Testing\n\nsome middle section.\n\n";
	const body = BRIEF + PLAN + MIDDLE + DEPS;
	const newPlan = "## Plan (plan-epic)\n\n### Product layer\n\nfresh plan prose.\n\n";
	const newDeps = "## Dependencies\n\n### Phase 1\n- #7 — new\n";

	it("replaces the plan section (up to the next `## `) and the deps section, keeping the middle", () => {
		const out = spliceEpicBody({body, deps: newDeps, plan: newPlan});
		assert.strictEqual(out._tag, "Spliced");
		if (out._tag !== "Spliced") return;
		expect(out.mode).toBe("replace");
		expect(out.body).toBe(BRIEF + newPlan + MIDDLE + newDeps);
	});

	it("preserves the brief and the middle section byte-for-byte", () => {
		const out = spliced(spliceEpicBody({body, deps: newDeps, plan: newPlan}));
		expect(out.startsWith(BRIEF)).toBe(true);
		expect(out).toContain(MIDDLE);
		expect(out).not.toContain("old plan prose");
	});

	it("does not treat the plan block's own `### Phase` sub-headings as a section boundary", () => {
		const planWithPhases = "## Plan (plan-epic)\n\n### Phase A\n\ntext\n\n### Phase B\n\nmore\n\n";
		const out = spliced(spliceEpicBody({body, deps: newDeps, plan: planWithPhases}));
		expect(out).toBe(BRIEF + planWithPhases + MIDDLE + newDeps);
	});
});

describe("corrupt-heading guards — refuse rather than orphan or double a section", () => {
	it("refuses a body with more than one `## Dependencies` heading", () => {
		const body = `${BRIEF}${DEPS}\n${DEPS}`;
		const reason = corruptReason(spliceEpicBody({body, deps: DEPS, plan: null}));
		expect(reason).toContain("2 exact '## Dependencies' headings");
	});

	it("refuses a re-plan whose body has zero `## Dependencies` headings (drifted/deleted)", () => {
		const body = BRIEF + PLAN; // no deps heading
		const reason = corruptReason(spliceEpicBody({body, deps: DEPS, plan: PLAN}));
		expect(reason).toContain("0 exact '## Dependencies' headings");
	});

	it("treats a drifted `## Dependencies (phased)` heading as zero (a re-plan then refuses)", () => {
		const body = `${BRIEF}${PLAN}## Dependencies (phased)\n\n### Phase 1\n- #1 — a\n`;
		const out = spliceEpicBody({body, deps: DEPS, plan: PLAN});
		expect(out._tag).toBe("Corrupt");
	});

	it("refuses a re-plan whose body lacks exactly one `## Plan (plan-epic)` heading", () => {
		const body = BRIEF + DEPS; // one deps heading, zero plan headings
		const reason = corruptReason(spliceEpicBody({body, deps: DEPS, plan: PLAN}));
		expect(reason).toContain("0 exact '## Plan (plan-epic)' headings");
	});

	it("refuses a re-plan whose body has two `## Plan (plan-epic)` headings", () => {
		const body = BRIEF + PLAN + PLAN + DEPS;
		const reason = corruptReason(spliceEpicBody({body, deps: DEPS, plan: PLAN}));
		expect(reason).toContain("2 exact '## Plan (plan-epic)' headings");
	});
});
