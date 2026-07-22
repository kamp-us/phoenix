import {describe, expect, it} from "vitest";
import {decideMergeIntent, type IntentSite, type MergeIntentState} from "./merge-intent.ts";

/** An open, unqueued, armed PR — the shape every disarm case starts from. */
const state = (over: Partial<MergeIntentState> = {}): MergeIntentState => ({
	armed: true,
	merged: false,
	queued: false,
	everQueued: false,
	...over,
});

const SITES: ReadonlyArray<IntentSite> = ["preflight", "refuse", "post-enqueue", "ejected"];

describe("decideMergeIntent — ship-it's no-parked-merge-intent invariant (ADR 0198, #3723)", () => {
	describe("a live merge-queue entry is never disturbed", () => {
		it.each(SITES)("keeps the intent at site %s when the PR is queued", (site) => {
			const d = decideMergeIntent(site, state({queued: true, everQueued: true}));
			expect(d.action).toBe("keep");
			expect(d.reason).toMatch(/merge-queue entry/);
		});

		it.each(SITES)("keeps the intent at site %s when the merge already landed", (site) => {
			const d = decideMergeIntent(site, state({merged: true, everQueued: true}));
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
			const d = decideMergeIntent("refuse", state({everQueued: true}));
			expect(d.action).toBe("disarm");
			expect(d.reason).toMatch(/next bare approval/);
		});

		it("disarms on a refuse even for a PR the queue never governed", () => {
			// The pre-queue exemption is scoped to `post-enqueue`; a refusing run never parks.
			expect(decideMergeIntent("refuse", state({everQueued: false})).action).toBe("disarm");
		});
	});

	describe("an ejected PR re-enters through a fresh gate pass (acceptance criterion 2)", () => {
		it("disarms on an ejection so the re-approval cannot re-enqueue on its own", () => {
			const d = decideMergeIntent("ejected", state({everQueued: true, queued: false}));
			expect(d.action).toBe("disarm");
			expect(d.reason).toMatch(/fresh ship-it gate pass/);
		});
	});

	describe("preflight clears a stale intent from an earlier or interrupted run", () => {
		it("disarms an arm that predates this run's guards", () => {
			const d = decideMergeIntent("preflight", state({everQueued: true}));
			expect(d.action).toBe("disarm");
			expect(d.reason).toMatch(/BEFORE this run's guards/);
		});

		it("disarms at preflight even with no merge-queue history — the arm is stale in either regime", () => {
			expect(decideMergeIntent("preflight", state({everQueued: false})).action).toBe("disarm");
		});
	});

	describe("post-enqueue distinguishes a parked intent from the pre-queue regime", () => {
		it("disarms when the queue governs this PR but it is not queued (a parked intent)", () => {
			const d = decideMergeIntent("post-enqueue", state({everQueued: true, queued: false}));
			expect(d.action).toBe("disarm");
			expect(d.reason).toMatch(/did not take effect/);
		});

		it("keeps when no merge-queue event has ever governed the PR (pre-queue auto-merge)", () => {
			const d = decideMergeIntent("post-enqueue", state({everQueued: false}));
			expect(d.action).toBe("keep");
			expect(d.reason).toMatch(/pre-queue auto-merge regime/);
		});
	});

	describe("fail-closed on an unreadable arm state", () => {
		it.each([
			"preflight",
			"refuse",
			"ejected",
		] as const)("treats an unknown arm as armed at site %s", (site) => {
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
