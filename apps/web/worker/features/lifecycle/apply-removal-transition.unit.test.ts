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
import {applyRemovalTransition} from "./apply-removal-transition.ts";
import * as Removal from "./removal.ts";

const now = new Date("2026-07-04T00:00:00.000Z");

// Logs every substrate call (the write's shape is `removal.ts`'s), into `order` when a test
// shares one to sequence the write against `afterCommit` and the refresh.
const recordingSeq = (order: string[] = []) => {
	const log = (op: string) =>
		Effect.sync(() => {
			order.push(op);
		});
	const seq: Removal.RemovalSequence = {
		run: <A>(_fn: unknown) => log("write").pipe(Effect.as(undefined as A)),
		batch: <A>(_fn: unknown) => log("write").pipe(Effect.as(undefined as A)),
		clearTarget: () => log("clearTarget"),
	};
	return {seq, writes: order};
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
			const {seq, writes} = recordingSeq();
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
			assert.deepStrictEqual(writes, [], "no-op must not reach the substrate");
			assert.isFalse(refreshed, "no-op must not run the refresh");
		}),
	);

	it.effect("restore on live (not-removed) content is a no-op", () =>
		Effect.gen(function* () {
			const {seq, writes} = recordingSeq();
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
			assert.deepStrictEqual(writes, [], "no-op must not reach the substrate");
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
			const order: string[] = [];
			const {seq} = recordingSeq(order);
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
			assert.deepStrictEqual(order, ["write", "afterCommit", "refresh"]);
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
