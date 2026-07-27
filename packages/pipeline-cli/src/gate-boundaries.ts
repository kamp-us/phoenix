/**
 * The typed source for every gate boundary that had none (issue #4401).
 *
 * `CONTROL_PLANE_RE` got a const in #2761; these ten did not — they lived only as `_RE=`
 * shell-assignment lines inside prose (`gh-issue-intake-formats.md`, `ship-it/SKILL.md`) and were
 * pulled back out at decision time by regex-over-prose or `grep`+`sed`. Nothing type-checked them,
 * nothing asserted they compiled, and a reflow or a stray `grep -n` prefix surviving into the `sed`
 * strip emptied one — at which point `grep -E ""` matches every line and `grep -Ev ""` matches none,
 * both at exit 0. This module is the machine source those prose lines are now drift-locked against
 * by `validate-gate-path-drift.sh`, plus the non-triviality predicate every runtime resolution site
 * checks before it uses a freshly-extracted pattern.
 *
 * PLACEMENT IS A CORRECTNESS PROPERTY, NOT A STYLE CALL. This file sits at the `src/` ROOT because
 * `CONTROL_PLANE_RE`'s `^packages/pipeline-cli/src/[^/]+$` clause is non-recursive: a root module is
 * §CP and human-merge-gated, while a fresh `src/tools/<dir>/` module is NOT §CP under ADR 0218's
 * enumerated core — so parking the single source of every gate boundary there would make it
 * mergeable with zero human review, a strictly worse hole than the one this closes. Do not relocate
 * it into a new tool directory; see ADR 0218 and #4401.
 *
 * The values are byte-identical copies of the prose lines, and stay that way by force: the
 * drift validator compares each one against `pipeline-cli control-plane-paths --boundary <NAME>`.
 * Backslashes are doubled as TS string escapes, so `\\.` is the value `\.` — the same convention
 * `control-plane-re.ts` uses.
 *
 * Runtime resolution is UNCHANGED and must stay that way (the #981 anti-self-authorization
 * property): the merge-deciding gates still re-resolve these patterns from the prose on
 * `origin/main`, so a boundary-editing PR is classified against MAIN's boundary rather than its own
 * edit. This module is the drift-lock target and the fail-closed reference — never a compile-time
 * substitute for that read.
 *
 * Zero imports on purpose: `src/` root is inside the §CP enforcement core, whose transitive import
 * closure `core-import-closure.unit.test.ts` pins (ADR 0218).
 */

/** §CP content clause — the guard-touching-ADR vocabulary (ADR 0164; formats §CP). */
export const GUARD_ADR_RE =
	"guard|invariant|fail-closed|fail-open|fail closed|fail open|containment|control-plane|control plane|§cp|self-weakening|blocking set|adversarial review|must never|hard-gate|hard gate|enforcement|\\bgat(e|es|ing|ed)\\b|relax|loosen|weaken|soften|widen|broaden|waive|bypass|exempt|carve[ -]?out|opt[ -]?out";

/**
 * The four artifact-class probes (formats §CLASS). `HAS_CODE_RE` and `HAS_DOCS_EXCLUDE_RE` name the
 * SAME code roots — the has-code/docs-exclusion agreement invariant — so they move in lockstep.
 */
export const HAS_CODE_RE = "^(apps|packages|\\.glossary|infra)/";
export const HAS_SKILLS_RE = "^claude-plugins/[^/]+/(skills|agents)/|^\\.claude-plugin/";
export const HAS_DOCS_EXCLUDE_RE = "^(claude-plugins|apps|packages|\\.glossary|infra)/";
export const HAS_DOCS_RE = "^(\\.decisions|\\.patterns)/|\\.md$";

/**
 * The doc/vocab-surface carve-then-test pair (formats §CLASS) — the issueless-allowance axis, NOT a
 * class probe. It omits `.glossary` where `HAS_DOCS_EXCLUDE_RE` excludes it; that divergence is the
 * surface-vs-class distinction (ADR 0075/0184), so the lockstep above does not extend to this pair.
 */
export const DOC_VOCAB_EXCLUDE_RE = "^(apps|packages|infra|claude-plugins)/";
export const DOC_VOCAB_SURFACE_RE = "^(\\.decisions|\\.patterns|\\.glossary)/|\\.md$";

/**
 * The agent-distinguishable claim marker (ADR 0115; formats §7), in the jq/PCRE form the prose and
 * the `gh api … | jq` resolution snippets use. The executable matcher stays the `RegExp` literal in
 * `tools/epic-lock/claim-resolution.ts`; `gate-boundaries.unit.test.ts` derives this string from
 * that literal, so the two cannot drift.
 */
export const CLAIM_RE = "(?i)^\\s*\\**\\s*claim:\\s*[0-9a-f-]{36}\\b";

/**
 * The additive has-ui probe (`ship-it/SKILL.md`) — carve test/spec out FIRST, then test for a
 * rendered surface, because ERE has no negative lookahead. `ship-it/SKILL.md@main` remains the live
 * source every consumer re-resolves from (#2341/#2470/#3071); these are its drift-lock target.
 */
export const UI_RE = "^apps/web/src/";
export const UI_EXCLUDE_RE = "\\.(test|spec)\\.tsx?$";

/**
 * Every boundary single-sourced here, keyed by the canonical shell-assignment name the prose lines
 * and the drift validator use. `CONTROL_PLANE_RE` is deliberately absent — it has its own const in
 * `tools/control-plane-paths/control-plane-re.ts`; the emitter composes the two into one namespace.
 */
export const GATE_BOUNDARIES: Readonly<Record<string, string>> = {
	GUARD_ADR_RE,
	HAS_CODE_RE,
	HAS_SKILLS_RE,
	HAS_DOCS_EXCLUDE_RE,
	HAS_DOCS_RE,
	DOC_VOCAB_EXCLUDE_RE,
	DOC_VOCAB_SURFACE_RE,
	CLAIM_RE,
	UI_RE,
	UI_EXCLUDE_RE,
};

/**
 * The shortest a resolved boundary may legitimately be. Every real pattern here is ≥ 14 characters;
 * the shortest fail-closed SENTINEL (`.`, `$^`) is 2. The bound sits between them on purpose: it
 * rejects the empty/truncated extraction without ever rejecting a value a caller chose deliberately
 * — a sentinel is never routed through this predicate, it is what the predicate falls back TO.
 */
export const MIN_BOUNDARY_LENGTH = 4;

/**
 * Did an extraction actually yield a pattern? A trivial value is the #4401 failure: it reads back
 * successfully, compiles, and silently inverts the gate's polarity — fail-CLOSED under `grep -E`,
 * fail-OPEN and output-less under `grep -Ev`. Absence is checkable; triviality is not, unless
 * something checks it.
 */
export const isNonTrivialBoundary = (value: string | null | undefined): value is string =>
	typeof value === "string" && value.trim().length >= MIN_BOUNDARY_LENGTH;

/** Thrown by `assertNonTrivialBoundary` — named so a caller can report WHICH boundary went trivial. */
export class TrivialGateBoundaryError extends Error {
	readonly boundaryName: string;
	readonly resolved: string | null | undefined;

	constructor(boundaryName: string, resolved: string | null | undefined) {
		super(
			`TRIVIAL-GATE-BOUNDARY: ${boundaryName} resolved to ${
				resolved === null || resolved === undefined
					? "nothing"
					: `a trivial value (${resolved.length} chars): ${JSON.stringify(resolved)}`
			} — refusing to gate on it (min ${MIN_BOUNDARY_LENGTH}; issue #4401)`,
		);
		this.name = "TrivialGateBoundaryError";
		this.boundaryName = boundaryName;
		this.resolved = resolved;
	}
}

/** Fail-closed-and-LOUD form, for a caller with nowhere safe to fall back to. */
export const assertNonTrivialBoundary = (
	boundaryName: string,
	resolved: string | null | undefined,
): string => {
	if (!isNonTrivialBoundary(resolved)) throw new TrivialGateBoundaryError(boundaryName, resolved);
	return resolved;
};

/**
 * Fail-closed-and-QUIET form, for a parser whose fallback is itself the safe direction: take the
 * resolved value only if it is non-trivial, else the caller's fail-closed sentinel. Distinct from a
 * plain `?? fallback`, which the empty string sails straight past — that is exactly how a truncated
 * extraction became a live gate decision (#4401).
 */
export const boundaryOrFailClosed = (
	resolved: string | null | undefined,
	failClosed: string,
): string => (isNonTrivialBoundary(resolved) ? resolved : failClosed);
