import {assert, describe, it} from "@effect/vitest";
import type {StagedEntry} from "./index.ts";
import {
	decidePrimaryIndexCommit,
	MASS_DELETION_BLOCK_THRESHOLD,
	type PrimaryIndexCommitInput,
} from "./primary-index-guard.ts";

const del = (path: string): StagedEntry => ({status: "D", path});

const input = (over: Partial<PrimaryIndexCommitInput> = {}): PrimaryIndexCommitInput => ({
	onPrimaryCheckout: true,
	staged: [],
	cwd: "/repo",
	agentType: "engineering-manager",
	sessionId: "sess-1",
	worktreeRoot: "",
	threshold: MASS_DELETION_BLOCK_THRESHOLD,
	at: "2026-07-12T00:00:00Z",
	...over,
});

const massDeletion = (n: number): StagedEntry[] =>
	Array.from({length: n}, (_, i) => del(`.claude/skills/x${i}.md`));

describe("decidePrimaryIndexCommit — blocks the #2778 signature on the PRIMARY checkout", () => {
	it("refuses a mass control-plane staged deletion on the primary (the loaded-gun commit)", () => {
		const decision = decidePrimaryIndexCommit(input({staged: massDeletion(248)}));
		assert.strictEqual(decision.kind, "refuse");
		if (decision.kind === "refuse") {
			assert.match(decision.reason, /#2778/);
			assert.strictEqual(decision.record.controlPlaneDeletionCount, 248);
			assert.isTrue(decision.record.onPrimaryCheckout);
		}
	});

	it("refuses exactly at the block threshold", () => {
		const decision = decidePrimaryIndexCommit(
			input({staged: massDeletion(MASS_DELETION_BLOCK_THRESHOLD)}),
		);
		assert.strictEqual(decision.kind, "refuse");
	});
});

describe("decidePrimaryIndexCommit — allows normal commits", () => {
	it("allows a below-threshold control-plane deletion (a legit small refactor is not the corruption)", () => {
		const decision = decidePrimaryIndexCommit(
			input({staged: massDeletion(MASS_DELETION_BLOCK_THRESHOLD - 1)}),
		);
		assert.strictEqual(decision.kind, "allow");
	});

	it("allows a normal commit with no control-plane deletions (a mass of ordinary-source deletions is fine)", () => {
		const staged = Array.from({length: 300}, (_, i) => del(`apps/web/src/old/x${i}.ts`));
		const decision = decidePrimaryIndexCommit(input({staged}));
		assert.strictEqual(decision.kind, "allow");
	});

	it("allows an empty staged set", () => {
		assert.strictEqual(decidePrimaryIndexCommit(input({staged: []})).kind, "allow");
	});
});

describe("decidePrimaryIndexCommit — scoped to the primary checkout", () => {
	it("ALLOWS a mass control-plane deletion in a linked worktree (it lands on a PR-reviewed branch)", () => {
		// The worktree's commit can never fast-forward origin/main; the read-only tripwire still
		// records it. Blocking here would false-refuse a legitimate worktree branch.
		const decision = decidePrimaryIndexCommit(
			input({onPrimaryCheckout: false, staged: massDeletion(248)}),
		);
		assert.strictEqual(decision.kind, "allow");
		if (decision.kind === "allow") assert.match(decision.reason, /worktree/);
	});
});
