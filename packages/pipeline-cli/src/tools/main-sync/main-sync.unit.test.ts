import {assert, describe, it} from "@effect/vitest";
import {
	DETACHED_LABEL,
	decideMainRefresh,
	decideMainSync,
	type HeadState,
	MAIN_BRANCH,
	type MainRefreshPlan,
	type MainSyncPlan,
} from "./main-sync.ts";

const head = (over: Partial<HeadState> = {}): HeadState => ({
	branch: "main",
	isDirty: false,
	hasTrackedModifications: false,
	...over,
});

describe("decideMainSync — already on main", () => {
	it("clean HEAD on main → already-on-main (no reattach)", () => {
		const plan = decideMainSync(head({branch: "main", isDirty: false}));
		assert.deepStrictEqual(plan, {action: "already-on-main", branch: MAIN_BRANCH});
	});

	it("dirty tree on main is irrelevant — still already-on-main (merge --ff-only fails safe on its own)", () => {
		// The tool never touches a tree already on the right branch; the dirty flag is
		// only consulted on the off-main path, so an on-main dirty tree is NOT blocked here.
		const plan = decideMainSync(head({branch: "main", isDirty: true}));
		assert.deepStrictEqual(plan, {action: "already-on-main", branch: MAIN_BRANCH});
	});
});

describe("decideMainSync — reattach (the #1494 recoverable case)", () => {
	it("detached + clean → reattach from detached-HEAD", () => {
		const plan = decideMainSync(head({branch: null, isDirty: false}));
		assert.deepStrictEqual(plan, {action: "reattach", from: DETACHED_LABEL});
	});

	it("off-main branch + clean → reattach from that branch", () => {
		const plan = decideMainSync(head({branch: "umut/some-branch", isDirty: false}));
		assert.deepStrictEqual(plan, {action: "reattach", from: "umut/some-branch"});
	});
});

describe("decideMainSync — blocked-dirty (detect-and-surface, never discard)", () => {
	it("detached + dirty → blocked-dirty, NOT reattach (a checkout could lose work)", () => {
		const plan = decideMainSync(head({branch: null, isDirty: true}));
		assert.deepStrictEqual(plan, {action: "blocked-dirty", from: DETACHED_LABEL});
	});

	it("off-main branch + dirty → blocked-dirty from that branch", () => {
		const plan = decideMainSync(head({branch: "umut/wip", isDirty: true}));
		assert.deepStrictEqual(plan, {action: "blocked-dirty", from: "umut/wip"});
	});

	it("dirty NEVER yields a reattach on the off-main path (safety invariant)", () => {
		const plans: MainSyncPlan[] = [
			decideMainSync({branch: null, isDirty: true, hasTrackedModifications: true}),
			decideMainSync({branch: "x", isDirty: true, hasTrackedModifications: true}),
		];
		for (const plan of plans) {
			assert.notStrictEqual(plan.action, "reattach");
		}
	});
});

describe("decideMainSync — totality", () => {
	it("every HeadState maps to exactly one of the three actions", () => {
		const cases: HeadState[] = [
			{branch: "main", isDirty: false, hasTrackedModifications: false},
			{branch: "main", isDirty: true, hasTrackedModifications: true},
			{branch: null, isDirty: false, hasTrackedModifications: false},
			{branch: null, isDirty: true, hasTrackedModifications: true},
			{branch: "feature", isDirty: false, hasTrackedModifications: false},
			{branch: "feature", isDirty: true, hasTrackedModifications: true},
		];
		const actions = new Set(["already-on-main", "reattach", "blocked-dirty"]);
		for (const c of cases) {
			assert.isTrue(actions.has(decideMainSync(c).action));
		}
	});
});

describe("decideMainRefresh — fast-forward (the only safe-to-advance state)", () => {
	it("clean HEAD on main → fast-forward", () => {
		const plan = decideMainRefresh(head({branch: "main", isDirty: false}));
		assert.deepStrictEqual(plan, {action: "fast-forward", branch: MAIN_BRANCH});
	});

	it("on main + untracked-only dirt → fast-forward (#2455: ff passes straight through untracked files)", () => {
		// The #2455 fix: a tree dirty ONLY with untracked files still fast-forwards. `merge --ff-only`
		// never touches untracked files, so blocking on them bought no safety and pinned primary stale.
		const plan = decideMainRefresh(
			head({branch: "main", isDirty: true, hasTrackedModifications: false}),
		);
		assert.deepStrictEqual(plan, {action: "fast-forward", branch: MAIN_BRANCH});
	});
});

describe("decideMainRefresh — leave-alone (never move HEAD, never error)", () => {
	it("on main + tracked modifications → leave-alone (reason dirty) — a ff could clobber tracked work", () => {
		const plan = decideMainRefresh(
			head({branch: "main", isDirty: true, hasTrackedModifications: true}),
		);
		assert.deepStrictEqual(plan, {action: "leave-alone", reason: "dirty", branch: MAIN_BRANCH});
	});

	it("clean feature branch → leave-alone (reason off-main) — never yank the owner onto main", () => {
		const plan = decideMainRefresh(head({branch: "umut/wip", isDirty: false}));
		assert.deepStrictEqual(plan, {action: "leave-alone", reason: "off-main", branch: "umut/wip"});
	});

	it("detached HEAD → leave-alone (reason off-main) from detached-HEAD", () => {
		const plan = decideMainRefresh(head({branch: null, isDirty: false}));
		assert.deepStrictEqual(plan, {
			action: "leave-alone",
			reason: "off-main",
			branch: DETACHED_LABEL,
		});
	});

	it("off-main takes precedence over tracked dirt — the branch is the binding reason the ff can't run", () => {
		// A feature branch with tracked modifications is reported off-main, not dirty: an ff of main
		// can't advance a checked-out feature branch regardless of tree state, so the branch is the
		// real blocker (checked ahead of the tracked-dirt guard).
		const plan = decideMainRefresh(
			head({branch: "umut/wip", isDirty: true, hasTrackedModifications: true}),
		);
		assert.deepStrictEqual(plan, {action: "leave-alone", reason: "off-main", branch: "umut/wip"});
	});

	it("NEVER yields a HEAD-moving action — leave-alone or fast-forward only, no reattach/checkout", () => {
		const cases: HeadState[] = [
			{branch: "main", isDirty: false, hasTrackedModifications: false},
			{branch: "main", isDirty: true, hasTrackedModifications: true},
			{branch: "main", isDirty: true, hasTrackedModifications: false},
			{branch: null, isDirty: false, hasTrackedModifications: false},
			{branch: null, isDirty: true, hasTrackedModifications: true},
			{branch: "feature", isDirty: false, hasTrackedModifications: false},
			{branch: "feature", isDirty: true, hasTrackedModifications: true},
		];
		const actions = new Set<MainRefreshPlan["action"]>(["fast-forward", "leave-alone"]);
		for (const c of cases) {
			assert.isTrue(actions.has(decideMainRefresh(c).action));
		}
	});
});
