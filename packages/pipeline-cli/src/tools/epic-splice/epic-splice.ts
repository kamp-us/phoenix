/**
 * `epic-splice` core — the pure, IO-free text transform behind `plan-epic`'s
 * epic-body splice (#3689), extracted from the ~95-line hand-composed splice the
 * skill's Step 5 carried inline (#261). Given the live epic body, a freshly-derived
 * `## Dependencies` block, and — on a re-plan — a fresh `## Plan (plan-epic)` block,
 * it produces the spliced body: a first-time APPEND of the deps block, or a re-plan
 * in-place REPLACE of the deps (and plan) sections, with the anchor-count guards that
 * refuse a corrupt-heading body rather than orphan or double a section.
 *
 * Only the deterministic text transform lives here. The optimistic `updated_at`
 * recheck + the abort-retry PATCH orchestration around it stay in the skill prose —
 * they are IO against the live GitHub issue, not a text function (#3689 scope).
 *
 * Byte-preservation is the load-bearing invariant: every byte OUTSIDE the replaced
 * section(s) survives verbatim, because the transform slices the live body on the
 * heading boundary rather than reconstructing it — so a concurrent edit to the brief
 * (or any other section) can never be clobbered by this write (#261, the lost-update
 * this splice exists to prevent).
 */

/** The re-plan mode is carried by the presence of a fresh plan block — a re-plan re-splices both sections. */
export interface SpliceInput {
	/** The live epic body, read immediately before the write (the base every splice preserves around). */
	readonly body: string;
	/** The freshly-derived `## Dependencies` block to append or splice in place. */
	readonly deps: string;
	/**
	 * The freshly-derived `## Plan (plan-epic)` block, present iff this is a re-plan.
	 * `null` ⇒ a first-time plan (only the deps block is written; the plan already sits
	 * in the body from Step 2). Non-null ⇒ re-plan (both sections are re-spliced).
	 */
	readonly plan: string | null;
}

/** `append` — first-time plan (no deps heading yet); `replace` — a deps section spliced in place. */
export type SpliceMode = "append" | "replace";

/** A successful splice, or a corrupt-heading refusal naming what it saw (never a blind write). */
export type SpliceOutcome =
	| {readonly _tag: "Spliced"; readonly body: string; readonly mode: SpliceMode}
	| {readonly _tag: "Corrupt"; readonly reason: string};

// The exact `## Dependencies` / `## Plan (plan-epic)` heading lines — a heading line is the
// literal text followed only by optional trailing whitespace (`[^\S\n]` = whitespace but not the
// newline). This mirrors the skill's `grep -c '^## Dependencies[[:space:]]*$'` anchor: a drifted
// heading (`## Dependencies (phased)`) has non-whitespace after the word, so it does NOT match —
// which is exactly what surfaces as a heading-count-0 corruption on a re-plan.
const DEPS_HEADING = /^## Dependencies[^\S\n]*$/m;
const DEPS_HEADING_G = /^## Dependencies[^\S\n]*$/gm;
const PLAN_HEADING = /^## Plan \(plan-epic\)[^\S\n]*$/m;
const PLAN_HEADING_G = /^## Plan \(plan-epic\)[^\S\n]*$/gm;
// The next top-level section boundary: a line starting with exactly `## ` (two hashes + space).
// A `### Phase N` sub-heading has three hashes, so it is NOT a boundary — the plan block's own
// `### ` sub-headings never terminate the replaced range (mirrors the skill's `/^## /` awk).
const NEXT_H2 = /^## /m;

const countHeadings = (body: string, re: RegExp): number => body.match(re)?.length ?? 0;

/**
 * Replace the inclusive range from `headingRe`'s first line up to (but excluding) the next
 * top-level `## ` heading with `block`. When the section is the last one (no following `## `),
 * replace through EOF. Mirrors the skill's in-place plan awk exactly.
 */
const spliceSection = (body: string, headingRe: RegExp, block: string): string => {
	const start = body.search(headingRe);
	// Start the next-boundary search AFTER the heading line so the heading itself (also `## `) is
	// not read as its own boundary — the skill's awk skips the heading line via `next`.
	const afterHeadingLine = body.indexOf("\n", start);
	const searchFrom = afterHeadingLine === -1 ? body.length : afterHeadingLine + 1;
	const rel = body.slice(searchFrom).search(NEXT_H2);
	const next = rel === -1 ? -1 : searchFrom + rel;
	return next === -1
		? body.slice(0, start) + block
		: body.slice(0, start) + block + body.slice(next);
};

/**
 * Splice the fresh `## Dependencies` (and, on a re-plan, `## Plan (plan-epic)`) block(s) into the
 * live body. The anchor-count guards decide first-time-append vs re-plan-replace vs corruption:
 *
 *   0 deps headings + first-time → APPEND the block to EOF (Step 2 hasn't pinned a topology yet)
 *   1 deps heading               → REPLACE it in place (a re-plan of an existing section)
 *   0 deps + re-plan, or >1 ever → corruption (heading drifted, deleted, or duplicated) → refuse
 *
 * On a re-plan the plan block is likewise required to have exactly one `## Plan (plan-epic)`
 * anchor, else the splice would drop or double the section — refuse rather than write.
 */
export const spliceEpicBody = ({body, deps, plan}: SpliceInput): SpliceOutcome => {
	const replan = plan !== null;

	const depsCount = countHeadings(body, DEPS_HEADING_G);
	if (depsCount > 1) {
		return {
			_tag: "Corrupt",
			reason: `live body has ${depsCount} exact '## Dependencies' headings (want 0 on a first-time plan, 1 on a re-plan) — refusing to splice; inspect by hand`,
		};
	}
	if (depsCount === 0 && replan) {
		return {
			_tag: "Corrupt",
			reason:
				"re-plan but live body has 0 exact '## Dependencies' headings (the pinned heading drifted or was deleted) — refusing to splice; inspect by hand",
		};
	}

	if (replan) {
		const planCount = countHeadings(body, PLAN_HEADING_G);
		if (planCount !== 1) {
			return {
				_tag: "Corrupt",
				reason: `re-plan but live body has ${planCount} exact '## Plan (plan-epic)' headings (want exactly 1) — refusing to splice; inspect by hand`,
			};
		}
	}

	// Splice the plan section FIRST (on the live body), then deps. In `plan-epic`'s canonical
	// brief → plan → dependencies layout the two edits touch disjoint regions, so order is
	// commutative and the output is byte-identical to the skill's deps-then-plan awk — but doing
	// plan first keeps the plan anchor resolvable against the body the guard counted, rather than a
	// body the deps splice may have already cut through.
	let working = body;
	if (plan !== null) {
		working = spliceSection(working, PLAN_HEADING, plan);
	}

	let spliced: string;
	let mode: SpliceMode;
	if (depsCount === 0) {
		// First-time: append to a verbatim copy of the live body — the brief + plan above are untouched.
		spliced = working + deps;
		mode = "append";
	} else {
		// Re-plan of deps: the pinned `## Dependencies` is the last section — cut from its heading to
		// EOF and re-append the fresh block. Everything before the heading is verbatim live bytes.
		const start = working.search(DEPS_HEADING);
		spliced = working.slice(0, start) + deps;
		mode = "replace";
	}

	return {_tag: "Spliced", body: spliced, mode};
};
