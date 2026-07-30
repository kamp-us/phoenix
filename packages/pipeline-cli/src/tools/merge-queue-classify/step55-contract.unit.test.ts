import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {assert, describe, it} from "@effect/vitest";
import {skillSurfaceFromDisk, skillSurfaceFromText} from "../../skill-shell-surface.ts";
import {classify, type MergeOutcome, type MergeQueueSignals} from "./merge-queue-classify.ts";
import {
	extractStep55Section,
	FAILCLOSED_RECONCILE_BUDGET,
	parseMergeDispositions,
	parseReconcileBudget,
	type ReconcileBudget,
	resolveStep55Section,
} from "./step55-contract.ts";

// The live skill — the single source for Step 5.5's budget and disposition wording. Read
// repo-relative off this file's own location so it resolves identically in CI and in a worktree. The
// SURFACE, not the file: the step's shell lives in the `scripts/*.sh` the section sources, and the
// parse follows into it (#4498), so this reaches the budget whether it was extracted or not.
const SHIP_IT_REL = "claude-plugins/kampus-pipeline/skills/ship-it/SKILL.md";
const SHIP_IT_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../../..", SHIP_IT_REL);
const SHIP_IT = skillSurfaceFromDisk(SHIP_IT_PATH, SHIP_IT_REL);
const LIVE_BUDGET = parseReconcileBudget(SHIP_IT);
const LIVE_DISPOSITIONS = parseMergeDispositions(SHIP_IT);

/** The budget as it stood before #4403 — the control the boundary cases are measured against. */
const OLD_BUDGET: ReconcileBudget = {
	tries: 10,
	sleepSeconds: 30,
	horizonSeconds: 270, // poll 10 fires at 9*30s; the 10th sleep observed nothing
	sleepsBetweenPollsOnly: false,
};

/**
 * The budget as Step 5.5 writes it, for the #4498 fixtures below. Built rather than spelled out so
 * biome's noTemplateCurlyInString stays quiet — these fixtures ARE shell, and a spelled-out
 * `${VAR:-N}` trips the rule on every line (the `settings-env-guard` idiom, #2495).
 */
const BUDGET_LINES: ReadonlyArray<string> = [
	`RECONCILE_TRIES=$\{SHIP_RECONCILE_TRIES:-16}`,
	`RECONCILE_SLEEP=$\{SHIP_RECONCILE_SLEEP:-30}`,
	'  if [ "$i" -lt "$RECONCILE_TRIES" ]; then sleep "$RECONCILE_SLEEP"; fi',
];
const BUDGET_16x30: ReconcileBudget = {
	tries: 16,
	sleepSeconds: 30,
	horizonSeconds: 450,
	sleepsBetweenPollsOnly: true,
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
		assert.deepStrictEqual(
			parseReconcileBudget(skillSurfaceFromText("")),
			FAILCLOSED_RECONCILE_BUDGET,
		);
		assert.strictEqual(FAILCLOSED_RECONCILE_BUDGET.horizonSeconds, 0);
		assert.strictEqual(parseMergeDispositions(skillSurfaceFromText("")).size, 0);
	});

	// The horizon identity above is VACUOUS at the fail-closed constant — 0 === (0-1)*0 — so it
	// passes on a corpus the parser could not read. Pin the budget's own non-triviality here, where
	// it is the assertion rather than a by-product, so an emptied parse reds on this row too.
	it("resolves a real budget, not the fail-closed zero", () => {
		assert.isAbove(LIVE_BUDGET.tries, 1);
		assert.isAbove(LIVE_BUDGET.sleepSeconds, 0);
		assert.isAbove(LIVE_BUDGET.horizonSeconds, 0);
	});
});

// The disposition population is DERIVED FROM THE TEXT and, until #4498, was never pinned: a case arm
// that stopped being reachable yielded an empty map, and every `notInclude`/`notStrictEqual` row
// above passes vacuously on `""`. That is the #4509 silent-dropout shape — green while covering one
// outcome fewer, with no symptom. The classifier's own union is the expected membership.
describe("Step 5.5's disposition population is pinned against MergeOutcome, so an arm cannot drop out", () => {
	const OUTCOMES: ReadonlyArray<MergeOutcome> = ["merged", "ejected", "queued", "pending"];

	it("renders every outcome word the classifier can print, and nothing is blank", () => {
		assert.deepStrictEqual([...LIVE_DISPOSITIONS.keys()].sort(), [...OUTCOMES].sort());
		for (const outcome of OUTCOMES) {
			assert.isAbove(
				(LIVE_DISPOSITIONS.get(outcome) ?? "").length,
				0,
				`Step 5.5 renders no disposition for \`${outcome}\``,
			);
		}
	});
});

// #4498. Before this, the parse read SKILL.md alone, so moving the reconcile block into a sourced
// script — a pure relocation — resolved a ZERO horizon and reddened the mirror.
describe("Step 5.5's parse follows the section's sourced scripts (extraction-invariant, #4498)", () => {
	it("emits its scanned scope, and that scope is never empty on a resolvable section", () => {
		const {scanned, unresolved} = resolveStep55Section(SHIP_IT);
		assert.isAbove(scanned.length, 0, `Step 5.5 resolved ZERO scope — scanned: ${scanned.join()}`);
		assert.strictEqual(scanned[0], SHIP_IT_REL);
		assert.deepStrictEqual(unresolved, [], "every script Step 5.5 sources must read back");
	});

	it("reaches the budget through the source line, not only inline in the markdown", () => {
		assert.match(resolveStep55Section(SHIP_IT).section, /^RECONCILE_TRIES=/m);
		// Non-vacuous, and precisely so: the markdown slice ALONE no longer carries the budget, so the
		// match above can only have come from a followed script.
		assert.notMatch(
			extractStep55Section(SHIP_IT.text),
			/^RECONCILE_TRIES=/m,
			"the budget is extracted (#4448), so the markdown slice alone must NOT carry it",
		);
	});

	it("resolves the budget from the script when the markdown no longer carries it", () => {
		const md = [
			"### Step 5.5 — Bounded post-enqueue reconcile",
			'. "$SHIPIT_SCRIPTS/reconcile.sh"',
			"",
			"#### Next",
		].join("\n");
		const script = BUDGET_LINES.join("\n");
		assert.deepStrictEqual(
			parseReconcileBudget(skillSurfaceFromText(md, {"reconcile.sh": script})),
			BUDGET_16x30,
		);
		// …and the un-followed corpus is exactly what fails: the same markdown with no script.
		assert.deepStrictEqual(
			parseReconcileBudget(skillSurfaceFromText(md)),
			FAILCLOSED_RECONCILE_BUDGET,
		);
	});

	it("still resolves a budget that lives INLINE — the old path is not traded away for the new one", () => {
		const inline = skillSurfaceFromText(
			[
				"### Step 5.5 — Bounded post-enqueue reconcile",
				"```bash",
				...BUDGET_LINES,
				"```",
				"#### Next",
			].join("\n"),
		);
		assert.deepStrictEqual(parseReconcileBudget(inline), BUDGET_16x30);
	});

	it("a section that sources an UNREADABLE script fails closed — UNKNOWN, never 'no budget'", () => {
		const missing = skillSurfaceFromText(
			[
				"### Step 5.5 — Bounded post-enqueue reconcile",
				'. "$SHIPIT_SCRIPTS/gone.sh"',
				...BUDGET_LINES,
				"#### Next",
			].join("\n"),
		);
		// The budget is RIGHT THERE inline — and it still refuses, because one file of the surface was
		// unreadable. A partial read is not a read.
		assert.deepStrictEqual(resolveStep55Section(missing).unresolved, ["gone.sh"]);
		assert.deepStrictEqual(parseReconcileBudget(missing), FAILCLOSED_RECONCILE_BUDGET);
	});

	it("a renamed heading is ZERO SCOPE, and zero scope fails rather than resolving", () => {
		const renamed = skillSurfaceFromText(`### Step 5.6 — renamed\n${BUDGET_LINES.join("\n")}\n`);
		assert.deepStrictEqual(resolveStep55Section(renamed).scanned, []);
		assert.deepStrictEqual(parseReconcileBudget(renamed), FAILCLOSED_RECONCILE_BUDGET);
		assert.strictEqual(parseMergeDispositions(renamed).size, 0);
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
