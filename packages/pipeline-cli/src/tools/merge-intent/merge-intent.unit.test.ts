import {describe, expect, it} from "vitest";
import {decideMergeIntent, type IntentSite, type MergeIntentState} from "./merge-intent.ts";

/** An open, unqueued, armed PR on a queue-governed base — the shape every disarm case starts from. */
const state = (over: Partial<MergeIntentState> = {}): MergeIntentState => ({
	armed: true,
	merged: false,
	queued: false,
	queueGoverned: true,
	...over,
});

const SITES: ReadonlyArray<IntentSite> = ["preflight", "refuse", "post-enqueue", "ejected"];

describe("decideMergeIntent — ship-it's no-parked-merge-intent invariant (ADR 0198, #3723)", () => {
	describe("a live merge-queue entry is never disturbed", () => {
		it.each(SITES)("keeps the intent at site %s when the PR is queued", (site) => {
			const d = decideMergeIntent(site, state({queued: true}));
			expect(d.action).toBe("keep");
			expect(d.reason).toMatch(/merge-queue entry/);
		});

		it.each(SITES)("keeps the intent at site %s when the merge already landed", (site) => {
			const d = decideMergeIntent(site, state({merged: true}));
			expect(d.action).toBe("keep");
		});
	});

	describe("nothing armed ⇒ nothing to clear", () => {
		it.each(SITES)("keeps at site %s when the PR carries no armed request", (site) => {
			expect(decideMergeIntent(site, state({armed: false})).action).toBe("keep");
		});
	});

	describe("the refusing/stopping run leaves no armed intent (acceptance criterion 1)", () => {
		it("disarms on a refuse — the §CP `awaiting control-plane approval` STOP", () => {
			const d = decideMergeIntent("refuse", state());
			expect(d.action).toBe("disarm");
			expect(d.reason).toMatch(/next bare approval/);
		});

		it("disarms on a refuse even on a base branch with no merge queue", () => {
			// The pre-queue exemption is scoped to `post-enqueue`; a refusing run never parks.
			expect(decideMergeIntent("refuse", state({queueGoverned: false})).action).toBe("disarm");
		});
	});

	describe("an ejected PR re-enters through a fresh gate pass (acceptance criterion 2)", () => {
		it("disarms on an ejection so the re-approval cannot re-enqueue on its own", () => {
			const d = decideMergeIntent("ejected", state({queued: false}));
			expect(d.action).toBe("disarm");
			expect(d.reason).toMatch(/fresh ship-it gate pass/);
		});
	});

	describe("preflight clears a stale intent from an earlier or interrupted run", () => {
		it("disarms an arm that predates this run's guards", () => {
			const d = decideMergeIntent("preflight", state());
			expect(d.action).toBe("disarm");
			expect(d.reason).toMatch(/BEFORE this run's guards/);
		});

		it("disarms at preflight on an unqueued base too — the arm is stale in either regime", () => {
			expect(decideMergeIntent("preflight", state({queueGoverned: false})).action).toBe("disarm");
		});
	});

	describe("post-enqueue keys the exemption on the BASE BRANCH regime, not the PR's history", () => {
		it("disarms when a merge queue governs the base but the PR is not queued (parked intent)", () => {
			const d = decideMergeIntent("post-enqueue", state({queueGoverned: true, queued: false}));
			expect(d.action).toBe("disarm");
			expect(d.reason).toMatch(/did not take effect/);
		});

		it("disarms a first-enqueue-attempt PR under a queue — the #3774 review's FAIL 1", () => {
			// A per-PR "has this ever been queued?" proxy reads false here and would keep the arm;
			// the branch regime says the queue governs this base, so the arm that never took is parked.
			expect(decideMergeIntent("post-enqueue", state({queueGoverned: true})).action).toBe("disarm");
		});

		it("keeps when no merge queue governs the base branch (pre-queue auto-merge)", () => {
			const d = decideMergeIntent("post-enqueue", state({queueGoverned: false}));
			expect(d.action).toBe("keep");
			expect(d.reason).toMatch(/pre-queue auto-merge regime/);
		});
	});

	describe("fail-closed on an unreadable read", () => {
		it.each(SITES)("treats an unknown arm as armed at site %s", (site) => {
			const d = decideMergeIntent(site, state({armed: "unknown"}));
			expect(d.action).toBe("disarm");
			expect(d.reason).toMatch(/unreadable/);
		});

		it("still keeps an unknown arm off a live queue entry", () => {
			// Fail-closed never means dequeuing a merge the queue owns.
			expect(decideMergeIntent("preflight", state({armed: "unknown", queued: true})).action).toBe(
				"keep",
			);
		});
	});
});
