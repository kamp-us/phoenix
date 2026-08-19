/**
 * `applyRemovalTransition` — the shared remove/restore ceremony single-sourced across
 * the pano post/comment + sözlük definition planes (#2012). Asserts, at the helper,
 * the invariant twelve public methods used to hand-inline and drift on: the
 * already-in-that-state guard short-circuits; `afterCommit` runs after the substrate
 * write and before the refresh; and the refresh is swallowed-and-logged UNIFORMLY
 * (#1639), so a refresh die never flips a committed transition into a failure.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Exit} from "effect";
import type {TargetKind} from "../../db/target-kind.ts";
import {applyRemovalTransition} from "./apply-removal-transition.ts";
import * as Removal from "./removal.ts";

const now = new Date("2026-07-04T00:00:00.000Z");

// Records what it was asked to write; the substrate write itself is `removal.ts`'s.
const recordingSeq = () => {
	const calls: Array<{op: "remove" | "restore"; kind: TargetKind}> = [];
	const seq: Removal.RemovalSequence = {
		run: <A>(_fn: unknown) => Effect.succeed(undefined as A),
		batch: <A>(_fn: unknown) => Effect.succeed(undefined as A),
		clearTarget: () => Effect.void,
	};
	return {seq, calls};
};

const liveColumns: Removal.RemovalColumns = {
	removedAt: null,
	removedBy: null,
	removedReason: null,
	sandboxedAt: null,
};
const removedColumns: Removal.RemovalColumns = {
	removedAt: now,
	removedBy: "mod-1",
	removedReason: Removal.encodeReason(new Removal.AuthorDeletion()),
	sandboxedAt: null,
};

describe("applyRemovalTransition — state guard", () => {
	it.effect("remove on already-removed content is a no-op (no write, no refresh)", () =>
		Effect.gen(function* () {
			const {seq} = recordingSeq();
			let refreshed = false;
			const outcome = yield* applyRemovalTransition({
				label: "test",
				transition: "remove",
				seq,
				subject: removedColumns,
				target: {kind: "post", id: "p1"},
				removedBy: "u1",
				reason: new Removal.AuthorDeletion(),
				now,
				refresh: Effect.sync(() => {
					refreshed = true;
				}),
			});
			assert.deepStrictEqual(outcome, {committed: false});
			assert.isFalse(refreshed, "no-op must not run the refresh");
		}),
	);

	it.effect("restore on live (not-removed) content is a no-op", () =>
		Effect.gen(function* () {
			const {seq} = recordingSeq();
			const outcome = yield* applyRemovalTransition({
				label: "test",
				transition: "restore",
				seq,
				subject: liveColumns,
				target: {kind: "comment", id: "c1"},
				now,
				refresh: Effect.void,
			});
			assert.deepStrictEqual(outcome, {committed: false});
		}),
	);
});

describe("applyRemovalTransition — commit + ordering", () => {
	it.effect("a remove commits and reports the round-tripped sandboxedAt", () =>
		Effect.gen(function* () {
			const {seq} = recordingSeq();
			const outcome = yield* applyRemovalTransition({
				label: "test",
				transition: "remove",
				seq,
				subject: liveColumns,
				target: {kind: "definition", id: "d1"},
				removedBy: "u1",
				reason: new Removal.AuthorDeletion(),
				now,
				refresh: Effect.void,
			});
			// live content was not sandboxed ⇒ the preserved marker is null.
			assert.deepStrictEqual(outcome, {committed: true, sandboxedAt: null});
		}),
	);

	it.effect("afterCommit runs after the substrate write and before the refresh", () =>
		Effect.gen(function* () {
			const {seq} = recordingSeq();
			const order: string[] = [];
			const outcome = yield* applyRemovalTransition({
				label: "test",
				transition: "restore",
				seq,
				subject: removedColumns,
				target: {kind: "comment", id: "c1"},
				now,
				afterCommit: () =>
					Effect.sync(() => {
						order.push("afterCommit");
					}),
				refresh: Effect.sync(() => {
					order.push("refresh");
				}),
			});
			assert.isTrue(outcome.committed);
			assert.deepStrictEqual(order, ["afterCommit", "refresh"]);
		}),
	);
});

describe("applyRemovalTransition — uniform swallow (#1639)", () => {
	it.effect("a refresh die after a committed remove still succeeds (committed:true)", () =>
		Effect.gen(function* () {
			const {seq} = recordingSeq();
			const exit = yield* applyRemovalTransition({
				label: "test",
				transition: "remove",
				seq,
				subject: liveColumns,
				target: {kind: "post", id: "p1"},
				removedBy: "u1",
				reason: new Removal.AuthorDeletion(),
				now,
				refresh: Effect.die(new Error("stats refresh must be swallowed post-commit")),
			}).pipe(Effect.exit);
			assert.isTrue(
				Exit.isSuccess(exit),
				"a recomputable-cache refresh die must NOT fail a committed transition",
			);
			if (Exit.isSuccess(exit)) assert.isTrue(exit.value.committed);
		}),
	);

	it.effect("a refresh die after a committed restore is likewise swallowed", () =>
		Effect.gen(function* () {
			const {seq} = recordingSeq();
			const exit = yield* applyRemovalTransition({
				label: "test",
				transition: "restore",
				seq,
				subject: removedColumns,
				target: {kind: "definition", id: "d1"},
				now,
				refresh: Effect.die(new Error("term-summary/stats refresh must be swallowed post-commit")),
			}).pipe(Effect.exit);
			assert.isTrue(Exit.isSuccess(exit));
			if (Exit.isSuccess(exit)) assert.isTrue(exit.value.committed);
		}),
	);
});
