import {assert, describe, it} from "@effect/vitest";
import {
	classifyRef,
	computeRefReclaimPlan,
	isManagedWorktreeRef,
	parseRefList,
	type RefCandidate,
} from "./ref-reclaim.ts";

/** A ref of the harness namespace, free (no worktree holds it) and provably merged — the deletable shape. */
const ref = (over: Partial<RefCandidate> = {}): RefCandidate => ({
	name: "worktree-agent-a003e5f0ac0a77cc4",
	tip: "e6a428355a54b2d8d1a8ad3e249cf27f2c8aa018",
	checkedOutAt: null,
	containment: "reachable",
	...over,
});

describe("isManagedWorktreeRef", () => {
	it("accepts the harness-created agent + workflow prefixes", () => {
		assert.isTrue(isManagedWorktreeRef("worktree-agent-a003e5f0ac0a77cc4"));
		assert.isTrue(isManagedWorktreeRef("worktree-wf-1234"));
	});

	it("rejects everything else — a human branch, a coder PR branch, and main", () => {
		assert.isFalse(isManagedWorktreeRef("main"));
		assert.isFalse(isManagedWorktreeRef("usirin/worktree-ref-reclaim-4190"));
		assert.isFalse(isManagedWorktreeRef("feature/worktree-things"));
	});
});

describe("classifyRef — the delete cases (positive containment only)", () => {
	it("deletes a free managed ref whose tip is an ancestor of origin/main", () => {
		assert.deepStrictEqual(classifyRef(ref()), {kind: "delete", reason: "merged"});
	});

	it("deletes a free managed ref whose content squash-merged (#1328)", () => {
		assert.deepStrictEqual(classifyRef(ref({containment: "squash-merged"})), {
			kind: "delete",
			reason: "squash-merged",
		});
	});
});

describe("classifyRef — every uncertain fact resolves to KEEP", () => {
	it("keeps a ref outside the worktree-* namespace even when merged", () => {
		assert.deepStrictEqual(classifyRef(ref({name: "usirin/some-work"})), {
			kind: "keep",
			reason: "out-of-scope",
		});
		assert.deepStrictEqual(classifyRef(ref({name: "main"})), {
			kind: "keep",
			reason: "out-of-scope",
		});
	});

	it("keeps a ref whose tip could not be resolved — nothing is provable and the delete has no expected value", () => {
		assert.deepStrictEqual(classifyRef(ref({tip: null})), {kind: "keep", reason: "tip-unresolved"});
	});

	it("keeps a checked-out ref regardless of containment — a lane may be sitting on it (#4178)", () => {
		for (const containment of ["reachable", "squash-merged", "absent", "unknown"] as const) {
			assert.deepStrictEqual(
				classifyRef(ref({checkedOutAt: "/repo/.claude/worktrees/agent-x", containment})),
				{kind: "keep", reason: "checked-out"},
				`containment=${containment}`,
			);
		}
	});

	it("keeps a ref whose containment probe was unreadable — unknown is never a licence to delete", () => {
		assert.deepStrictEqual(classifyRef(ref({containment: "unknown"})), {
			kind: "keep",
			reason: "containment-unknown",
		});
	});

	it("keeps a ref proven NOT on origin/main — the ref is the only thing keeping that work reachable", () => {
		assert.deepStrictEqual(classifyRef(ref({containment: "absent"})), {
			kind: "keep",
			reason: "unmerged",
		});
	});

	it("checks scope before containment, so an unknown-containment human branch is out-of-scope, not unknown", () => {
		assert.deepStrictEqual(classifyRef(ref({name: "main", containment: "unknown"})), {
			kind: "keep",
			reason: "out-of-scope",
		});
	});

	it("keeps an unresolved tip even when a worktree holds it — the earlier gate wins, both KEEP", () => {
		assert.deepStrictEqual(classifyRef(ref({tip: null, checkedOutAt: "/repo/wt"})), {
			kind: "keep",
			reason: "tip-unresolved",
		});
	});
});

describe("computeRefReclaimPlan", () => {
	it("partitions the deletable from the kept, preserving the per-ref reason", () => {
		const plan = computeRefReclaimPlan([
			ref({name: "worktree-agent-merged"}),
			ref({name: "worktree-agent-squashed", containment: "squash-merged"}),
			ref({name: "worktree-agent-live", checkedOutAt: "/repo/.claude/worktrees/agent-live"}),
			ref({name: "worktree-agent-unmerged", containment: "absent"}),
			ref({name: "worktree-agent-unprobed", containment: "unknown"}),
			ref({name: "usirin/mine"}),
		]);
		assert.deepStrictEqual(
			plan.toDelete.map((d) => [d.ref.name, d.reason]),
			[
				["worktree-agent-merged", "merged"],
				["worktree-agent-squashed", "squash-merged"],
			],
		);
		assert.deepStrictEqual(
			plan.kept.map((k) => [k.ref.name, k.reason]),
			[
				["worktree-agent-live", "checked-out"],
				["worktree-agent-unmerged", "unmerged"],
				["worktree-agent-unprobed", "containment-unknown"],
				["usirin/mine", "out-of-scope"],
			],
		);
	});

	it("narrows a planned delete to a non-null tip, so the boundary's compare-and-delete always has one", () => {
		const plan = computeRefReclaimPlan([ref()]);
		assert.strictEqual(plan.toDelete[0]?.ref.tip, "e6a428355a54b2d8d1a8ad3e249cf27f2c8aa018");
	});

	it("deletes nothing from an empty scan", () => {
		assert.deepStrictEqual(computeRefReclaimPlan([]), {toDelete: [], kept: []});
	});
});

describe("parseRefList", () => {
	it("parses name/tip pairs and ignores blank lines", () => {
		assert.deepStrictEqual(parseRefList("worktree-agent-a\tsha1\n\nworktree-wf-b\tsha2\n"), [
			{name: "worktree-agent-a", tip: "sha1"},
			{name: "worktree-wf-b", tip: "sha2"},
		]);
	});

	it("keeps a malformed entry with a null tip rather than dropping it — it must still appear in the plan", () => {
		assert.deepStrictEqual(parseRefList("worktree-agent-a\nworktree-agent-b\t\n"), [
			{name: "worktree-agent-a", tip: null},
			{name: "worktree-agent-b", tip: null},
		]);
		assert.deepStrictEqual(
			computeRefReclaimPlan([ref({name: "worktree-agent-a", tip: null})]).toDelete,
			[],
		);
	});
});
