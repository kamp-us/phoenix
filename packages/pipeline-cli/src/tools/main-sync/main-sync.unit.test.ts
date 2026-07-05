import {assert, describe, it} from "@effect/vitest";
import {
	DETACHED_LABEL,
	decideMainSync,
	type HeadState,
	MAIN_BRANCH,
	type MainSyncPlan,
} from "./main-sync.ts";

const head = (over: Partial<HeadState> = {}): HeadState => ({
	branch: "main",
	isDirty: false,
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
			decideMainSync({branch: null, isDirty: true}),
			decideMainSync({branch: "x", isDirty: true}),
		];
		for (const plan of plans) {
			assert.notStrictEqual(plan.action, "reattach");
		}
	});
});

describe("decideMainSync — totality", () => {
	it("every HeadState maps to exactly one of the three actions", () => {
		const cases: HeadState[] = [
			{branch: "main", isDirty: false},
			{branch: "main", isDirty: true},
			{branch: null, isDirty: false},
			{branch: null, isDirty: true},
			{branch: "feature", isDirty: false},
			{branch: "feature", isDirty: true},
		];
		const actions = new Set(["already-on-main", "reattach", "blocked-dirty"]);
		for (const c of cases) {
			assert.isTrue(actions.has(decideMainSync(c).action));
		}
	});
});
