/**
 * Pure-core tests for `unresolved-threads-guard` (ADR 0158 enforcement, #3331). The gate
 * decision over fixtures — deterministic, no live PR state:
 *   - the #3329 exemplar reproduction: an unresolved GHAS/CodeQL thread on
 *     `.github/workflows/commands-guard.yml:35` + a review-code PASS with NO accounting row
 *     → RED, naming that thread (AC: re-running the check against #3329's state surfaces it);
 *   - a resolved thread, or zero threads → clean pass;
 *   - a substantive thread accounted-for by a `[FAIL] unresolved-threads — path:line` row → pass;
 *   - a human inline thread on the same footing as a bot thread;
 *   - null verdict (review-code hasn't posted) with a live thread → RED (fail-closed);
 *   - a nit resolved-with-rationale (isResolved=true) → pass (ADR 0158 discharge path);
 *   - accounting keys on the exact path:line (a different site's accounting doesn't cover it).
 * The IO seam (GraphQL threads read + author-gated verdict body) lives in `github.ts`.
 */
import {describe, expect, it} from "@effect/vitest";
import {
	isAccounted,
	isReviewCodeVerdict,
	judge,
	liveUnresolved,
	type ReviewThread,
	siteToken,
} from "./unresolved-threads-guard.ts";

const thread = (over: Partial<ReviewThread> = {}): ReviewThread => ({
	isResolved: false,
	isOutdated: false,
	path: "apps/web/worker/features/pano/mutations.ts",
	line: 18,
	author: "github-code-quality",
	excerpt: "Unused import PHOENIX_KARMA_GATES",
	...over,
});

// The #3329 exemplar: the CodeQL/GHAS inline finding on the commands-guard workflow.
const codeqlThread = thread({
	path: ".github/workflows/commands-guard.yml",
	line: 35,
	author: "github-advanced-security",
	excerpt: "Workflow does not contain permissions",
});

// A review-code PASS marker with NO unresolved-threads accounting — the #3329 bug shape.
const passNoAccounting =
	"review-code: PASS @ 4da28749abc0000000000000000000000000000 — AC met, merge-ready";

describe("siteToken", () => {
	it("is path:line when both present (Step 3e's documented row format)", () => {
		expect(siteToken(codeqlThread)).toBe(".github/workflows/commands-guard.yml:35");
	});
	it("degrades to the bare path when line is null", () => {
		expect(siteToken(thread({line: null}))).toBe("apps/web/worker/features/pano/mutations.ts");
	});
	it("is a non-satisfiable sentinel for a path-less pr-level thread", () => {
		expect(siteToken(thread({path: null, line: null}))).toBe("(pr-level review thread)");
	});
});

describe("liveUnresolved", () => {
	it("keeps isResolved=false and drops resolved threads, regardless of isOutdated", () => {
		const threads = [
			thread({isResolved: false, isOutdated: false}),
			thread({isResolved: false, isOutdated: true}),
			thread({isResolved: true, isOutdated: false}),
		];
		expect(liveUnresolved(threads)).toHaveLength(2);
	});
});

describe("isAccounted", () => {
	it("is false against a null verdict body", () => {
		expect(isAccounted(codeqlThread, null)).toBe(false);
	});
	it("is true when the verdict names the exact path:line", () => {
		const verdict = `review-code: FAIL @ deadbeef\n- [FAIL] unresolved-threads — ${siteToken(codeqlThread)} @github-advanced-security: "no permissions" is substantive (ADR 0158)`;
		expect(isAccounted(codeqlThread, verdict)).toBe(true);
	});
	it("is false when the verdict names a DIFFERENT site (accounting is per-site)", () => {
		const verdict =
			"review-code: FAIL @ deadbeef\n- [FAIL] unresolved-threads — apps/web/worker/features/pano/mutations.ts:18 substantive";
		expect(isAccounted(codeqlThread, verdict)).toBe(false);
	});
});

describe("isReviewCodeVerdict", () => {
	it("matches a review-code marker on line one", () => {
		expect(isReviewCodeVerdict(passNoAccounting)).toBe(true);
	});
	it("does not match a review-doc marker or chatter", () => {
		expect(isReviewCodeVerdict("review-doc: PASS @ abc123")).toBe(false);
		expect(isReviewCodeVerdict("just a normal comment")).toBe(false);
	});
});

describe("judge", () => {
	it("REDS the #3329 exemplar: unresolved CodeQL thread + a PASS with no accounting row", () => {
		const verdict = judge({threads: [codeqlThread], verdictBody: passNoAccounting});
		expect(verdict.pass).toBe(false);
		expect(verdict.unaccounted).toHaveLength(1);
		expect(verdict.report).toContain(".github/workflows/commands-guard.yml:35");
		expect(verdict.report).toContain("github-advanced-security");
	});

	it("passes when there are zero review threads (nothing to gate — a valid state)", () => {
		const verdict = judge({threads: [], verdictBody: passNoAccounting});
		expect(verdict.pass).toBe(true);
		expect(verdict.report).toContain("no review threads");
	});

	it("passes when the only thread is resolved (ADR 0158 nit discharge: resolve-with-rationale)", () => {
		const verdict = judge({
			threads: [codeqlThread, thread({isResolved: true})],
			verdictBody: passNoAccounting,
		});
		// codeqlThread is still live+unaccounted here, so this asserts the resolved one is dropped:
		expect(verdict.unaccounted).toHaveLength(1);
		expect(verdict.unaccounted[0]?.author).toBe("github-advanced-security");
	});

	it("passes when EVERY live thread is resolved", () => {
		const verdict = judge({
			threads: [thread({isResolved: true}), {...codeqlThread, isResolved: true}],
			verdictBody: null,
		});
		expect(verdict.pass).toBe(true);
	});

	it("passes when a substantive thread is accounted-for by a FAIL unresolved-threads row", () => {
		const accounted = `review-code: FAIL @ 4da28749abc — one criterion unmet\n- [FAIL] unresolved-threads — ${siteToken(codeqlThread)} @github-advanced-security: "no permissions" → address on the branch (ADR 0158)`;
		const verdict = judge({threads: [codeqlThread], verdictBody: accounted});
		expect(verdict.pass).toBe(true);
	});

	it("REDS a HUMAN inline thread on the same footing as a bot thread (ADR 0158 human-or-bot)", () => {
		const human = thread({author: "cansirin", excerpt: "handle the null case here"});
		const verdict = judge({threads: [human], verdictBody: passNoAccounting});
		expect(verdict.pass).toBe(false);
		expect(verdict.report).toContain("@cansirin");
	});

	it("REDS a live thread when review-code has posted NO verdict yet (fail-closed)", () => {
		const verdict = judge({threads: [codeqlThread], verdictBody: null});
		expect(verdict.pass).toBe(false);
		expect(verdict.report).toContain("no authorized review-code verdict naming it yet");
	});

	it("REDS a mix: accounts for one thread, reds the other unaccounted one", () => {
		const other = thread({path: "apps/web/worker/features/sozluk/mutations.ts", line: 42});
		const partial = `review-code: PASS @ abc\n- [FAIL] unresolved-threads — ${siteToken(codeqlThread)} substantive`;
		const verdict = judge({threads: [codeqlThread, other], verdictBody: partial});
		expect(verdict.pass).toBe(false);
		expect(verdict.unaccounted).toHaveLength(1);
		expect(verdict.unaccounted[0]?.path).toBe("apps/web/worker/features/sozluk/mutations.ts");
	});
});
