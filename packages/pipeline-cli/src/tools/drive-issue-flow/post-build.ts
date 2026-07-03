/**
 * `drive-issue` post-build routing — the pure, IO-free decision that reads the coder
 * stage's structured return and decides whether the run proceeds into the review/repair
 * loop or short-circuits on a sanctioned coder BACK-OFF (issue #1682).
 *
 * The executor `.claude/workflows/drive-issue.js` dispatches the coder and gets back
 * `{ pr, headSha }`. On a **sanctioned back-off** — the coder found a precondition failed,
 * filed a blocker issue, and released its claim without opening a PR — it returns
 * `pr === 0`. Before this decision existed the loop treated `0` as a real PR number and
 * entered review/repair against a nonexistent `pulls/0`: the reviewer emitted a FAIL on
 * `sha 0000…`, repair agents 404'd on `GET …/pulls/0`, and the loop churned to
 * `freeze-after-2` — ~5 wasted agent dispatches misreported as a frozen lane (#1682).
 *
 * This module is that routing decision as a single tested unit, so the short-circuit has
 * an explicit, verifiable contract instead of living only in workflow prose. The workflow
 * inlines the same one-line rule because a workflow script — top-level `return`, injected
 * globals — is not importable; this module is its canonical mirror and the one that
 * carries the unit test (the `trivial-diff/route.ts` sibling shape, ADR 0120 §3).
 *
 * **The rule, in one line:** a coder return with `pr <= 0` (canonically `0`) is a
 * back-off ⇒ short-circuit the review/repair loop entirely (no reviewer, no repair round,
 * no `pulls/0` fetch) and return a distinct `{ backedOff: true, blocker? }` terminal
 * result, unambiguously separable from the `freeze-after-2` frozen result. Any positive
 * PR number proceeds to review exactly as before.
 */

/** The shape the coder (`build`) stage returns — a PR number and its head sha. */
export interface BuildResult {
	/** The opened PR number, or `0` on a sanctioned back-off (no PR opened). */
	readonly pr: number;
	/** The PR head sha, or a `"none — no PR opened: …"` sentinel on a back-off. */
	readonly headSha: string;
	/**
	 * Optional explicit blocker issue number the coder filed when it backed off. When the
	 * coder emits it, the terminal result carries it so a reader can jump straight to the
	 * filed blocker; absent, the back-off is still detected off `pr` alone.
	 */
	readonly blocker?: number;
}

/**
 * A coder return is a **back-off** iff it opened no real PR — `pr` is not a positive
 * integer (canonically `0`, the value the coder emits on a sanctioned back-off). A missing
 * / non-numeric `pr` is treated as a back-off too: with no real PR number there is nothing
 * to review, so short-circuiting fail-closed is correct (never fetch `pulls/0`). Only a
 * strictly-positive integer PR number proceeds into the review/repair loop.
 */
export const isCoderBackOff = (built: BuildResult): boolean =>
	!Number.isInteger(built.pr) || built.pr <= 0;

/** The distinct terminal result a back-off short-circuits to (issue #1682 AC). */
export interface BackedOffResult {
	readonly backedOff: true;
	readonly pr: 0;
	readonly issue: number;
	/** The blocker issue the coder filed, when it emitted one. */
	readonly blocker?: number;
	readonly reason: string;
}

/**
 * Build the distinct back-off terminal result for the driven `issue`. Unambiguously
 * separable from the `{ frozen: true, reason: "freeze-after-2" }` frozen result — a reader
 * (or an outer orchestrator) can tell "coder legitimately declined and filed a blocker"
 * apart from "pipeline froze on a real but unrepairable PR". Carries `blocker` only when
 * the coder emitted a real blocker issue number.
 */
export const backOffResult = (issue: number, built: BuildResult): BackedOffResult => ({
	backedOff: true,
	pr: 0,
	issue,
	...(Number.isInteger(built.blocker) && (built.blocker as number) > 0
		? {blocker: built.blocker as number}
		: {}),
	reason: "coder backed off — precondition failed, blocker filed, claim released (no PR opened)",
});
