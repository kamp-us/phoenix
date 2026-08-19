import {describe, expect, it} from "vitest";
import type {ReviewThread} from "../ship/github.ts";
import {
	isAccounted,
	judge,
	liveUnresolved,
	siteToken,
	unaccountedIn,
} from "./unresolved-threads.ts";

const thread = (over: Partial<ReviewThread> = {}): ReviewThread => ({
	id: "PRRT_kwDOLxx1",
	isResolved: false,
	path: "apps/web/worker/features/pano/mutations.ts",
	line: 18,
	declaredComments: 1,
	comments: [
		{
			author: "github-code-quality",
			authorType: "Bot",
			body: "Unused import PHOENIX_KARMA_GATES",
		},
	],
	...over,
});

/** The #3329 exemplar: the CodeQL/GHAS inline finding on the commands-guard workflow. */
const codeql = thread({
	id: "PRRT_kwDOCodeQL",
	path: ".github/workflows/commands-guard.yml",
	line: 35,
	comments: [
		{
			author: "github-advanced-security",
			authorType: "Bot",
			body: "Workflow does not contain permissions",
		},
	],
});

/** A review-code PASS with NO unresolved-threads accounting — the #3329 bug shape. */
const PASS_NO_ACCOUNTING =
	"review-code: PASS @ 4da28749abc0000000000000000000000000000 — AC met, merge-ready";

const reportOf = (verdict: ReturnType<typeof judge>): string =>
	verdict._tag === "Violation" ? verdict.report : "";

describe("siteToken", () => {
	it("is path:line when both are present — ADR 0158's documented row format", () => {
		expect(siteToken(codeql)).toBe(".github/workflows/commands-guard.yml:35");
	});

	it("degrades to the bare path when the line is null", () => {
		expect(siteToken(thread({line: null}))).toBe("apps/web/worker/features/pano/mutations.ts");
	});

	it("is a sentinel no verdict satisfies by coincidence for a path-less pr-level thread", () => {
		expect(siteToken(thread({path: null, line: null}))).toBe("(pr-level review thread)");
	});
});

describe("liveUnresolved", () => {
	it("keeps the unresolved and drops the resolved", () => {
		const threads = [thread(), thread({id: "b"}), thread({id: "c", isResolved: true})];
		expect(liveUnresolved(threads)).toHaveLength(2);
	});
});

describe("isAccounted", () => {
	it("is false against a null verdict body", () => {
		expect(isAccounted(codeql, null)).toBe(false);
	});

	it("is true when the verdict names the exact path:line", () => {
		const verdict = `review-code: FAIL @ deadbeef1234567 — one criterion unmet\n- [FAIL] unresolved-threads — ${siteToken(codeql)} @github-advanced-security: "no permissions" is substantive (ADR 0158)`;
		expect(isAccounted(codeql, verdict)).toBe(true);
	});

	it("is false when the verdict names a DIFFERENT site — accounting is per-site", () => {
		const verdict =
			"review-code: FAIL @ deadbeef1234567 — unmet\n- [FAIL] unresolved-threads — apps/web/worker/features/pano/mutations.ts:18 substantive";
		expect(isAccounted(codeql, verdict)).toBe(false);
	});
});

describe("judge", () => {
	it("REDS the #3329 exemplar: an unresolved CodeQL thread under a PASS with no accounting row", () => {
		const verdict = judge({threads: [codeql], verdictBody: PASS_NO_ACCOUNTING});
		expect(verdict._tag).toBe("Violation");
		expect(reportOf(verdict)).toContain(".github/workflows/commands-guard.yml:35");
		expect(reportOf(verdict)).toContain("github-advanced-security");
		expect(reportOf(verdict)).toContain("ADR 0158");
	});

	it("annotates each unaccounted thread at its own path:line", () => {
		const verdict = judge({threads: [codeql], verdictBody: PASS_NO_ACCOUNTING});
		expect(verdict._tag === "Violation" && verdict.annotations).toEqual([
			{
				level: "error",
				message: expect.stringContaining(".github/workflows/commands-guard.yml:35"),
				location: {_tag: "Line", file: ".github/workflows/commands-guard.yml", line: 35},
			},
		]);
	});

	it("passes with zero review threads — a valid state, never zero scope", () => {
		const verdict = judge({threads: [], verdictBody: PASS_NO_ACCOUNTING});
		expect(verdict._tag).toBe("Clean");
		expect(verdict._tag === "Clean" && verdict.summary).toContain("no review threads");
		expect(verdict._tag === "Clean" && verdict.scanned).toBe(0);
	});

	it("drops a resolved thread from the accounting — ADR 0158's resolve-with-rationale discharge", () => {
		const unaccounted = unaccountedIn({
			threads: [codeql, thread({isResolved: true})],
			verdictBody: PASS_NO_ACCOUNTING,
		});
		expect(unaccounted).toHaveLength(1);
		expect(unaccounted[0]?.id).toBe("PRRT_kwDOCodeQL");
	});

	it("passes when EVERY thread is resolved, even with no verdict at all", () => {
		const verdict = judge({
			threads: [thread({isResolved: true}), {...codeql, isResolved: true}],
			verdictBody: null,
		});
		expect(verdict._tag).toBe("Clean");
	});

	it("passes when a thread is accounted-for by a FAIL row — the check is polarity-blind", () => {
		const accounted = `review-code: FAIL @ 4da28749abc0000 — one criterion unmet\n- [FAIL] unresolved-threads — ${siteToken(codeql)} @github-advanced-security: "no permissions" → address on the branch (ADR 0158)`;
		expect(judge({threads: [codeql], verdictBody: accounted})._tag).toBe("Clean");
	});

	it("REDS a HUMAN inline thread on the same footing as a bot one", () => {
		const human = thread({
			comments: [{author: "cansirin", authorType: "User", body: "handle the null case here"}],
		});
		const verdict = judge({threads: [human], verdictBody: PASS_NO_ACCOUNTING});
		expect(verdict._tag).toBe("Violation");
		expect(reportOf(verdict)).toContain("@cansirin");
	});

	it("REDS a live thread when review-code has posted no verdict at all — fail-closed", () => {
		const verdict = judge({threads: [codeql], verdictBody: null});
		expect(verdict._tag).toBe("Violation");
		expect(reportOf(verdict)).toContain("no authorized review-code verdict naming them yet");
	});

	it("REDS a pr-level thread: the sentinel is not satisfiable, so it fails closed", () => {
		const prLevel = thread({path: null, line: null});
		const verdict = judge({
			threads: [prLevel],
			verdictBody: `review-code: PASS @ 4da28749abc0000 — every thread pr-level and fine`,
		});
		expect(verdict._tag).toBe("Violation");
		expect(verdict._tag === "Violation" && verdict.annotations[0]?.location).toEqual({
			_tag: "Unlocated",
		});
	});

	it("REDS a mix: accounts for one thread and reds the other", () => {
		const other = thread({
			id: "PRRT_other",
			path: "apps/web/worker/features/sozluk/mutations.ts",
			line: 42,
		});
		const partial = `review-code: PASS @ 4da28749abc0000 — merge-ready\n- [FAIL] unresolved-threads — ${siteToken(codeql)} substantive`;
		const unaccounted = unaccountedIn({threads: [codeql, other], verdictBody: partial});
		expect(unaccounted).toHaveLength(1);
		expect(unaccounted[0]?.path).toBe("apps/web/worker/features/sozluk/mutations.ts");
	});
});
