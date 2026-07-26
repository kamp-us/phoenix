import {assert, describe, it} from "@effect/vitest";
import {parseAgentLockOwner} from "../worktree-reap/worktree-reap.ts";
import {isReviewHeadWorktree} from "../worktree-sweep/worktree-sweep.ts";
import {formatAgentLockReason, sessionPid} from "./agent-lock.ts";

describe("formatAgentLockReason — the reason materialize writes round-trips to the reaper (#4004)", () => {
	it("parses back to the owning pid through parseAgentLockOwner (the contract, both sides)", () => {
		const reason = formatAgentLockReason({
			pr: 4004,
			pid: 58975,
			startedAt: new Date("2026-07-25T23:48:53.000Z"),
		});
		assert.deepStrictEqual(parseAgentLockOwner(reason), {pid: 58975});
	});

	it("carries the `claude agent` prefix — without it the reaper reads NO owner at all", () => {
		const reason = formatAgentLockReason({pr: 7, pid: 42, startedAt: new Date(0)});
		assert.isTrue(reason.startsWith("claude agent "));
		assert.include(reason, "review-head-7");
	});

	it("names the tree a review-head tree, matching what the reclaimers scope on", () => {
		// The lock's agent id and the tree's basename are the two halves of the same class; a
		// mismatch would lock a tree nothing scopes over.
		assert.isTrue(isReviewHeadWorktree("/var/folders/8f/tmp.x/review-head-4004-aBc"));
	});
});

describe("sessionPid — the OWNING session's pid, never this CLI process's", () => {
	const registry = [
		{pid: 111, sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"},
		{pid: 222, sessionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"},
	];

	it("finds the registered pid for this run's session id", () => {
		assert.strictEqual(sessionPid(registry, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"), 222);
	});

	it("matches case-insensitively and ignores surrounding whitespace", () => {
		assert.strictEqual(sessionPid(registry, " AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA "), 111);
	});

	it("returns null for an unregistered session — no lock rather than an unattributable one", () => {
		assert.isNull(sessionPid(registry, "cccccccc-cccc-cccc-cccc-cccccccccccc"));
	});

	it("returns null when the session id is absent or empty (no $CLAUDE_CODE_SESSION_ID)", () => {
		assert.isNull(sessionPid(registry, undefined));
		assert.isNull(sessionPid(registry, "   "));
	});

	it("returns null against an empty/unreadable registry", () => {
		assert.isNull(sessionPid([], "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"));
	});
});
