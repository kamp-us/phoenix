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

/**
 * The `--epic` enrichment envelope, byte for byte per the `## triage enrich` section of
 * `claude-plugins/fabrika/skills/triage/contract.md`. `fabrika triage enrich --epic` writes it;
 * `plan-epic` then splices around it, which is what these fixtures exercise.
 */
const EPIC_ORIGINAL = "## Summary\n\nThe reporter's own brief.  \nA `code` span and a — dash.\n";
const EPIC_DETAILS = `<details>\n<summary>Original brief (verbatim)</summary>\n\n${EPIC_ORIGINAL}\n</details>\n`;
const EPIC_PITCH =
	"## Pitch\n\n**Problem:** who has it, and what stalls.\n**Arc:** fabrika campaign\n" +
	"**Appetite:** 1 cycles\n**Rabbit-holes:** none named.\n**No-gos:** none named.\n\n";
const EPIC_HEADER_BLOCK =
	"## Epic — awaiting plan\n\n`plan-epic` appends its plan and dependency topology below.\n\n";
const EPIC_ENVELOPE = EPIC_PITCH + EPIC_HEADER_BLOCK + EPIC_DETAILS;

const SUMMARY_LINE = "<summary>Original brief (verbatim)</summary>";
const EPIC_HEADER_RE = /^## Epic — awaiting plan[^\S\n]*$/m;

/**
 * The RETIRED terminality rule: a body read as already-enriched only when the `<details>` block was
 * the last block and closed at end-of-body. Kept here as the falsified predicate — #4850's whole
 * defect is that `spliceEpicBody` makes this false on every planned epic, at which point the old
 * "first enrichment ⇒ wrap" branch re-wrapped pitch, header, plan and topology inside a fresh
 * `Original brief (verbatim)` block, compounding per run.
 */
const readsAsEnrichedByTerminality = (body: string): boolean =>
	body.includes(SUMMARY_LINE) && /<\/details>[^\S\n]*\n?$/.test(body);

/**
 * The ruled position-independent detector (option (a), founder ruling on #4850): all three anchors
 * must hold, and where the `<details>` block sits relative to end-of-body is not tested at all.
 */
const readsAsEnrichedByAnchors = (body: string): boolean => {
	const headerAt = body.search(EPIC_HEADER_RE);
	const summaryAt = body.indexOf(SUMMARY_LINE);
	return body.startsWith("## Pitch\n") && headerAt !== -1 && summaryAt > headerAt;
};

const occurrences = (body: string, needle: string): number => body.split(needle).length - 1;

describe("the fabrika `--epic` envelope survives the splice — #4850's position-independent anchors", () => {
	const epicPlan = "## Plan (plan-epic)\n\n### Product layer\n\nthe authored plan.\n\n";
	const epicDeps = "## Dependencies\n\n### Phase 1\n- #10 — x\n";
	// What `plan-epic` Step 2 leaves: the plan written below the untouched envelope, no topology yet.
	const beforeFirstPlan = EPIC_ENVELOPE + epicPlan;

	it("the envelope alone reads as enriched under BOTH the retired and the ruled detector", () => {
		expect(readsAsEnrichedByTerminality(EPIC_ENVELOPE)).toBe(true);
		expect(readsAsEnrichedByAnchors(EPIC_ENVELOPE)).toBe(true);
	});

	it("a first-time plan appends below the wrap, which falsifies terminality (the #4850 root cause)", () => {
		const out = spliced(spliceEpicBody({body: beforeFirstPlan, deps: epicDeps, plan: null}));
		expect(out).toBe(beforeFirstPlan + epicDeps);
		expect(readsAsEnrichedByTerminality(out)).toBe(false);
	});

	it("but the three ruled anchors all still hold on that same planned body", () => {
		const out = spliced(spliceEpicBody({body: beforeFirstPlan, deps: epicDeps, plan: null}));
		expect(out.startsWith("## Pitch\n")).toBe(true);
		expect(out.search(EPIC_HEADER_RE)).toBe(EPIC_PITCH.length);
		expect(out.indexOf(SUMMARY_LINE)).toBeGreaterThan(out.search(EPIC_HEADER_RE));
		expect(readsAsEnrichedByAnchors(out)).toBe(true);
	});

	it("preserves the wrapped original byte-for-byte through a first-time plan", () => {
		const out = spliced(spliceEpicBody({body: beforeFirstPlan, deps: epicDeps, plan: null}));
		expect(out).toContain(EPIC_DETAILS);
		expect(occurrences(out, SUMMARY_LINE)).toBe(1);
	});

	it("keeps every anchor and the wrap intact through a re-plan of BOTH sections", () => {
		const body = beforeFirstPlan + epicDeps;
		const freshPlan = "## Plan (plan-epic)\n\n### Product layer\n\nre-planned prose.\n\n";
		const freshDeps = "## Dependencies\n\n### Phase 1\n- #11 — y\n";
		const out = spliced(spliceEpicBody({body, deps: freshDeps, plan: freshPlan}));
		expect(out).toBe(EPIC_ENVELOPE + freshPlan + freshDeps);
		expect(out.startsWith("## Pitch\n")).toBe(true);
		expect(out.search(EPIC_HEADER_RE)).toBe(EPIC_PITCH.length);
		expect(out).toContain(EPIC_DETAILS);
		expect(occurrences(out, SUMMARY_LINE)).toBe(1);
		expect(readsAsEnrichedByAnchors(out)).toBe(true);
	});

	it("never cuts on `## Pitch` or `## Epic — awaiting plan` — they are not splice anchors", () => {
		const body = beforeFirstPlan + epicDeps;
		const freshDeps = "## Dependencies\n\n### Phase 1\n- #12 — z\n";
		const out = spliced(spliceEpicBody({body, deps: freshDeps, plan: null}));
		// Everything above the pinned `## Dependencies` heading is verbatim live bytes, envelope included.
		expect(out).toBe(EPIC_ENVELOPE + epicPlan + freshDeps);
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
