import {assert, describe, it} from "@effect/vitest";
import {
	fetchRefspec,
	type HeadResolution,
	type PullHeadPayload,
	perRunRef,
	planMaterialization,
	type ResolvedHead,
	resolveHead,
} from "./resolve-head.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

const pull = (over: Partial<PullHeadPayload> = {}): PullHeadPayload => ({
	number: 42,
	state: "open",
	head: {sha: SHA, ref: "usirin/feature", repoFullName: "kamp-us/phoenix"},
	baseRepoFullName: "kamp-us/phoenix",
	...over,
});

const asResolved = (r: HeadResolution): ResolvedHead => {
	assert.strictEqual(r._tag, "resolved");
	if (r._tag !== "resolved") throw new Error("unreachable");
	return r;
};

describe("resolveHead — the latest head from the REST payload", () => {
	it("resolves the current head SHA (lowercased) and ref for a same-repo PR", () => {
		const r = resolveHead(pull());
		assert.deepStrictEqual(r, {
			_tag: "resolved",
			headSha: SHA,
			headRef: "usirin/feature",
			crossFork: false,
		});
	});

	it("takes REST's `.head.sha` verbatim as the latest head — no history to walk", () => {
		// REST always returns the PR's current head, so a second, newer push just shows up as a
		// different `.head.sha` on the next read; the core has no stale-head branch to guard.
		const newer = "fedcba9876543210fedcba9876543210fedcba98";
		const r = asResolved(
			resolveHead(pull({head: {sha: newer, ref: "b", repoFullName: "kamp-us/phoenix"}})),
		);
		assert.strictEqual(r.headSha, newer);
	});

	it("flags a cross-fork head (head repo != base repo) while still resolving it", () => {
		const r = asResolved(
			resolveHead(pull({head: {sha: SHA, ref: "patch-1", repoFullName: "someone/phoenix"}})),
		);
		assert.isTrue(r.crossFork);
	});

	it("resolves a head whose branch was deleted (SHA still bindable, ref empty)", () => {
		const r = asResolved(resolveHead(pull({head: {sha: SHA, ref: null, repoFullName: null}})));
		assert.strictEqual(r.headRef, "");
		assert.strictEqual(r.headSha, SHA);
	});
});

describe("resolveHead — missing-PR fail-safe", () => {
	it("is unresolvable when the head object is absent (missing/closed PR)", () => {
		const r = resolveHead(pull({number: 7, state: "closed", head: null}));
		assert.strictEqual(r._tag, "unresolvable");
		if (r._tag === "unresolvable") assert.match(r.reason, /#7.*no head SHA/);
	});

	it("is unresolvable when the head SHA is null", () => {
		const r = resolveHead(pull({head: {sha: null, ref: "x", repoFullName: "kamp-us/phoenix"}}));
		assert.strictEqual(r._tag, "unresolvable");
	});

	it("is unresolvable when the head SHA is not a full 40-hex commit", () => {
		const r = resolveHead(
			pull({head: {sha: "0123abc", ref: "x", repoFullName: "kamp-us/phoenix"}}),
		);
		assert.strictEqual(r._tag, "unresolvable");
		if (r._tag === "unresolvable") assert.match(r.reason, /not a full 40-hex/);
	});
});

describe("planMaterialization — detached-vs-branch (never switch onto the head branch)", () => {
	const head = asResolved(resolveHead(pull()));

	it("checks out the head DETACHED onto the per-run ref, never `git checkout <headRef>`", () => {
		const plan = planMaterialization(head, {pr: 42, nonce: "abc123"});
		assert.isTrue(plan.detach);
		assert.strictEqual(plan.prRef, "refs/pr/42-abc123");
		// The checkout target is the per-run REF, not the head BRANCH — §RO forbids a branch switch.
		assert.notStrictEqual(plan.prRef, head.headRef);
		assert.strictEqual(plan.fetchRefspec, "pull/42/head:refs/pr/42-abc123");
	});

	it("PR-namespaces AND nonce-uniques the ref so concurrent reviews of one PR never collide (#1807)", () => {
		const a = planMaterialization(head, {pr: 42, nonce: "run-a"});
		const b = planMaterialization(head, {pr: 42, nonce: "run-b"});
		assert.notStrictEqual(a.prRef, b.prRef);
		assert.strictEqual(perRunRef(42, "run-a"), a.prRef);
	});

	it("carries a worktree dir only when a full tree is requested (else ref-only, null)", () => {
		assert.strictEqual(planMaterialization(head, {pr: 42, nonce: "n"}).worktreeDir, null);
		assert.strictEqual(
			planMaterialization(head, {pr: 42, nonce: "n", worktreeDir: "/tmp/rh-42"}).worktreeDir,
			"/tmp/rh-42",
		);
	});

	it("fetchRefspec resolves same-repo and cross-fork identically (pull/<pr>/head)", () => {
		assert.strictEqual(fetchRefspec(7, "refs/pr/7-x"), "pull/7/head:refs/pr/7-x");
	});
});
