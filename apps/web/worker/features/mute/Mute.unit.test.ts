/**
 * Mute unit coverage — the decisions that are wrong-or-right with no database
 * (ADR 0082, the `Bookmark.unit.test.ts` idiom): the `Drizzle` seam is substituted
 * directly. A `run`/`batch` that THROWS proves a short-circuit never touched the DB;
 * a stubbed `run` feeds the pre-write decision its inputs without an engine.
 *
 * Mute's real-D1 fidelity — composite-PK presence idempotency, the set/readMutedIds
 * round-trip over real rows — lands at the integration tier once a sibling wires the
 * fate/mutation surface this storage slice intentionally omits (there is no HTTP/fate
 * surface yet to drive Mute black-box over).
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess, type DrizzleDb} from "../../db/Drizzle.ts";
import {Mute, MuteLive} from "./Mute.ts";

// A `Drizzle` whose every call throws — any path that actually reaches the DB seam
// fails the test. A guard that short-circuits before reading runs to completion
// against it, which is exactly the "no read" proof.
const throwingAccess: DrizzleAccess = {
	run: () => Effect.die(new Error("Mute read the DB on a path that must short-circuit")),
	batch: () => Effect.die(new Error("Mute wrote a batch on a path that must short-circuit")),
};

// A `Drizzle` whose `run` replays a queued sequence of results and whose `batch`
// throws — drives `set`'s pre-write presence probe while proving the idempotent
// no-op never reaches `batch`.
function scriptedAccess(results: ReadonlyArray<unknown>): {access: DrizzleAccess; runs: number} {
	const state = {i: 0};
	const access: DrizzleAccess = {
		run: <A>(fn: (db: DrizzleDb) => Promise<A>) => {
			void fn;
			const value = results[state.i++] as A;
			return Effect.succeed(value);
		},
		batch: () => Effect.die(new Error("idempotent no-op set must not reach the batch")),
	};
	return {
		access,
		get runs() {
			return state.i;
		},
	};
}

const muteLayer = (access: DrizzleAccess) =>
	MuteLive.pipe(Layer.provide(Layer.succeed(Drizzle, access)));

describe("Mute.set — self-mute rejection (mocked Drizzle seam)", () => {
	it.effect("a member muting themselves is rejected before any read", () =>
		Effect.gen(function* () {
			const mute = yield* Mute;
			const exit = yield* Effect.exit(mute.set({muterId: "u1", mutedId: "u1", value: true}));
			assert.isTrue(exit._tag === "Failure", "self-mute fails");
			assert.match(String(exit._tag === "Failure" ? exit.cause : ""), /SelfMuteRejected/);
		}).pipe(Effect.provide(muteLayer(throwingAccess))),
	);
});

describe("Mute.set — pre-write idempotency (mocked Drizzle seam)", () => {
	it.effect("re-muting an already-muted member is an idempotent no-op — no batch", () => {
		// run #1 presence probe → already muted. The `batch` stub throws, so reaching it fails.
		const {access} = scriptedAccess([{mutedId: "u2"}]);
		return Effect.gen(function* () {
			const mute = yield* Mute;
			const result = yield* mute.set({muterId: "u1", mutedId: "u2", value: true});
			assert.isFalse(result.changed, "matching state is a no-op");
			assert.isTrue(result.isMuted, "already-muted → isMuted true");
			assert.strictEqual(result.mutedId, "u2");
		}).pipe(Effect.provide(muteLayer(access)));
	});

	it.effect("un-muting a never-muted pair is an idempotent no-op — no batch", () => {
		// run #1 presence probe → not muted.
		const {access} = scriptedAccess([undefined]);
		return Effect.gen(function* () {
			const mute = yield* Mute;
			const result = yield* mute.set({muterId: "u1", mutedId: "u2", value: false});
			assert.isFalse(result.changed, "matching state is a no-op");
			assert.isFalse(result.isMuted, "never-muted → isMuted false");
			assert.strictEqual(result.mutedId, "u2");
		}).pipe(Effect.provide(muteLayer(access)));
	});
});

describe("Mute.readMutedIds — no-read short-circuit + batched read (mocked Drizzle seam)", () => {
	it.effect("null viewer → empty Set without touching the DB", () =>
		Effect.gen(function* () {
			const mute = yield* Mute;
			const muted = yield* mute.readMutedIds(null);
			assert.strictEqual(muted.size, 0);
		}).pipe(Effect.provide(muteLayer(throwingAccess))),
	);

	it.effect("undefined viewer → empty Set without touching the DB", () =>
		Effect.gen(function* () {
			const mute = yield* Mute;
			const muted = yield* mute.readMutedIds(undefined);
			assert.strictEqual(muted.size, 0);
		}).pipe(Effect.provide(muteLayer(throwingAccess))),
	);

	it.effect("a viewer's muted ids come back as a Set from one batched read", () => {
		// a single read returns the whole muted set for the viewer (keyed on muter_id).
		const {access, runs} = ((): {access: DrizzleAccess; runs: () => number} => {
			const state = {i: 0};
			return {
				access: {
					run: <A>(fn: (db: DrizzleDb) => Promise<A>) => {
						void fn;
						state.i++;
						return Effect.succeed([{mutedId: "u2"}, {mutedId: "u3"}] as A);
					},
					batch: () => Effect.die(new Error("readMutedIds must not batch")),
				},
				runs: () => state.i,
			};
		})();
		return Effect.gen(function* () {
			const mute = yield* Mute;
			const muted = yield* mute.readMutedIds("u1");
			assert.strictEqual(muted.size, 2);
			assert.isTrue(muted.has("u2") && muted.has("u3"));
			assert.strictEqual(runs(), 1, "exactly one batched read, no N+1");
		}).pipe(Effect.provide(muteLayer(access)));
	});
});
