import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {assert, describe, it} from "@effect/vitest";
import {classify, type MergeOutcome, type MergeQueueSignals} from "./merge-queue-classify.ts";
import {
	FAILCLOSED_RECONCILE_BUDGET,
	parseMergeDispositions,
	parseReconcileBudget,
	type ReconcileBudget,
} from "./step55-contract.ts";

// The live skill — the single source for Step 5.5's budget and disposition wording. Read
// repo-relative off this file's own location so it resolves identically in CI and in a worktree.
const SHIP_IT_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../..",
	"claude-plugins/kampus-pipeline/skills/ship-it/SKILL.md",
);
const SHIP_IT_TEXT = readFileSync(SHIP_IT_PATH, "utf8");
const LIVE_BUDGET = parseReconcileBudget(SHIP_IT_TEXT);
const LIVE_DISPOSITIONS = parseMergeDispositions(SHIP_IT_TEXT);

/** The budget as it stood before #4403 — the control the boundary cases are measured against. */
const OLD_BUDGET: ReconcileBudget = {
	tries: 10,
	sleepSeconds: 30,
	horizonSeconds: 270, // poll 10 fires at 9*30s; the 10th sleep observed nothing
	sleepsBetweenPollsOnly: false,
};

/**
 * Merge-queue dwell (`added_to_merge_queue` → `merged`) in seconds, measured off the REST timeline
 * of ten landed PRs (#4403). Every one of them MERGED — none is a failure case.
 */
const MEASURED_DWELLS = {
	"#4329": 565,
	"#4384": 454,
	"#4350": 405,
	"#4369": 404,
	"#4366": 395,
	"#4376": 380,
	"#4331": 355,
	"#4327": 354,
	"#4335": 339,
	"#4362": 317,
} as const;
const DWELLS = Object.values(MEASURED_DWELLS);
const MEDIAN_DWELL = 387.5;
const MEAN_DWELL = 396.8;

const queuedSignals: MergeQueueSignals = {
	merged: false,
	state: "OPEN",
	lastMergeQueueEvent: "added_to_merge_queue",
};

/** A healthy PR the queue lands at `dwell` — the removal pairs with the `merged` event (#4155). */
const landsAt =
	(dwell: number) =>
	(t: number): MergeQueueSignals =>
		t >= dwell
			? {
					merged: true,
					state: "MERGED",
					lastMergeQueueEvent: "removed_from_merge_queue",
					mergedTimelineEvent: true,
				}
			: queuedSignals;

/** A genuine dequeue at `t0`: removed from the queue with NO `merged` event to pair it with. */
const dequeuedAt =
	(t0: number) =>
	(t: number): MergeQueueSignals =>
		t >= t0
			? {
					merged: false,
					state: "OPEN",
					lastMergeQueueEvent: "removed_from_merge_queue",
					mergedTimelineEvent: false,
				}
			: queuedSignals;

/**
 * A test-local mirror of Step 5.5's reconcile loop, so the outcome a shipper reaches on a given
 * dwell is executable rather than only prose. The budget is not hand-copied — it is parsed off the
 * live skill, so widening or narrowing the block moves these cases with it. The per-poll verdict is
 * the REAL classifier: this mirror adds no classification of its own.
 */
const reconcile = (
	budget: ReconcileBudget,
	signalsAt: (t: number) => MergeQueueSignals,
): {readonly outcome: MergeOutcome; readonly lastObservedAt: number} => {
	let outcome: MergeOutcome = "pending";
	let lastObservedAt = 0;
	for (let k = 1; k <= budget.tries; k++) {
		lastObservedAt = (k - 1) * budget.sleepSeconds;
		outcome = classify(signalsAt(lastObservedAt)).outcome;
		if (outcome === "merged" || outcome === "ejected") break;
	}
	return {outcome, lastObservedAt};
};

const dispositionFor = (outcome: MergeOutcome): string => LIVE_DISPOSITIONS.get(outcome) ?? "";

describe("ship-it Step 5.5's reconcile budget, read off the live SKILL.md", () => {
	it("observes to the LAST poll, not to the loop's exit — the horizon is (tries-1)*sleep", () => {
		assert.strictEqual(
			LIVE_BUDGET.horizonSeconds,
			(LIVE_BUDGET.tries - 1) * LIVE_BUDGET.sleepSeconds,
		);
	});

	it("sleeps only BETWEEN polls, so no budget is spent observing nothing", () => {
		assert.isTrue(LIVE_BUDGET.sleepsBetweenPollsOnly);
	});

	it("watches past the median and mean measured dwell — the old 4m30s horizon did neither", () => {
		assert.isAbove(LIVE_BUDGET.horizonSeconds, MEDIAN_DWELL);
		assert.isAbove(LIVE_BUDGET.horizonSeconds, MEAN_DWELL);
		assert.isBelow(OLD_BUDGET.horizonSeconds, Math.min(...DWELLS));
	});

	it("still does not cover the longest measured dwell — which is why the wording, not the width, is the fix", () => {
		assert.isBelow(LIVE_BUDGET.horizonSeconds, MEASURED_DWELLS["#4329"]);
	});

	it("fails closed on a Step 5.5 it cannot read, rather than resolving a plausible horizon", () => {
		assert.deepStrictEqual(parseReconcileBudget(""), FAILCLOSED_RECONCILE_BUDGET);
		assert.strictEqual(FAILCLOSED_RECONCILE_BUDGET.horizonSeconds, 0);
		assert.strictEqual(parseMergeDispositions("").size, 0);
	});
});

describe("Step 5.5's stand-down wording — an expired observation reads UNRESOLVED, never terminal", () => {
	const unresolved = dispositionFor("queued");

	it("states the outcome is unresolved and that the merge may still land", () => {
		assert.include(unresolved, "UNRESOLVED");
		assert.include(unresolved, "may still land");
	});

	it("carries the horizon it actually watched, from the variable — never a hardcoded number", () => {
		assert.match(unresolved, /\$\{RECONCILE_HORIZON\}s after enqueue/);
	});

	it("says in words that it is not a failure, so no caller reads it as 'did not merge'", () => {
		assert.include(unresolved, "not a failure");
		assert.include(unresolved, "not a landing");
	});

	it("drops the two words that asserted more than any expired reconcile observed", () => {
		assert.notInclude(unresolved, "reconciled");
		assert.notInclude(unresolved, "auto-merges on green");
	});

	it("renders `pending` — the enqueue-settle window — with the same unresolved wording", () => {
		assert.strictEqual(dispositionFor("pending"), unresolved);
	});

	it("keeps landed / unresolved / EJECTED textually distinct — the three-way is not collapsed", () => {
		const renderings = [dispositionFor("merged"), unresolved, dispositionFor("ejected")];
		assert.include(renderings[0] ?? "", "landed");
		assert.include(renderings[2] ?? "", "EJECTED");
		assert.strictEqual(new Set(renderings).size, 3);
		for (const r of renderings) assert.notStrictEqual(r, "");
	});
});

describe("Step 5.5's boundary, executed against the real classifier", () => {
	it("still queued at the horizon ⇒ UNRESOLVED, not a failure (the 9m25s dwell of PR #4329)", () => {
		const run = reconcile(LIVE_BUDGET, landsAt(MEASURED_DWELLS["#4329"]));
		assert.strictEqual(run.outcome, "queued");
		assert.strictEqual(run.lastObservedAt, LIVE_BUDGET.horizonSeconds);
		assert.include(dispositionFor(run.outcome), "UNRESOLVED");
		assert.notStrictEqual(dispositionFor(run.outcome), dispositionFor("ejected"));
		assert.notStrictEqual(dispositionFor(run.outcome), dispositionFor("merged"));
	});

	it("a merge that lands past the OLD 5m bound is now reported as landed (the 5m17s dwell of PR #4362)", () => {
		const dwell = MEASURED_DWELLS["#4362"];
		assert.isAbove(dwell, OLD_BUDGET.horizonSeconds); // the regression: the old budget missed it
		assert.strictEqual(reconcile(OLD_BUDGET, landsAt(dwell)).outcome, "queued");

		const run = reconcile(LIVE_BUDGET, landsAt(dwell));
		assert.strictEqual(run.outcome, "merged");
		assert.include(dispositionFor(run.outcome), "landed");
	});

	it("eight of the ten measured dwells now land inside the horizon (the old budget caught none), and none of the ten reads as a failure", () => {
		const landed = DWELLS.filter((d) => reconcile(LIVE_BUDGET, landsAt(d)).outcome === "merged");
		assert.strictEqual(landed.length, 8);
		assert.strictEqual(
			DWELLS.filter((d) => reconcile(OLD_BUDGET, landsAt(d)).outcome === "merged").length,
			0,
		);
		for (const d of DWELLS) {
			const outcome = reconcile(LIVE_BUDGET, landsAt(d)).outcome;
			assert.notStrictEqual(outcome, "ejected");
			assert.include(["merged", "queued"], outcome);
		}
	});

	it("a genuine dequeue-without-merge is NOT-LANDED — it ejects and breaks out early", () => {
		const run = reconcile(LIVE_BUDGET, dequeuedAt(120));
		assert.strictEqual(run.outcome, "ejected");
		assert.strictEqual(run.lastObservedAt, 120);
		assert.include(dispositionFor(run.outcome), "EJECTED");
	});

	it("the mirror is not vacuous: an unresolved run and an ejected run reach different dispositions", () => {
		const stillQueued = reconcile(LIVE_BUDGET, () => queuedSignals);
		const ejected = reconcile(LIVE_BUDGET, dequeuedAt(0));
		assert.notStrictEqual(stillQueued.outcome, ejected.outcome);
		assert.notStrictEqual(dispositionFor(stillQueued.outcome), dispositionFor(ejected.outcome));
	});
});
