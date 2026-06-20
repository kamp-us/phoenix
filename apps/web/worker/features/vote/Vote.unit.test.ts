/**
 * Vote unit coverage — the decisions that are wrong-or-right with no database
 * (ADR 0082). The `Drizzle` seam is substituted directly (`Drizzle.test.ts`
 * half-A idiom): a `run`/`batch` that THROWS proves a short-circuit never
 * touched the DB, and a stubbed `run` feeds the decision its inputs without an
 * engine. Vote's real-D1 fidelity — composite-PK idempotency (score stays 1 on
 * re-cast), aggregate counters, soft-delete `VoteTargetNotFound`, the cast
 * round-trip — lives on real D1 over the fate ops in `tests/integration/`
 * (`pano-comments.test.ts` vote idempotency/round-trip, `pano-mutations.test.ts`
 * vote/retract, `pasaport.test.ts` totalKarma 0→1→0); its batch-atomicity
 * rollback is the generic `db.batch` all-or-nothing property proven in
 * `db/Drizzle.test.ts`.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess, type DrizzleDb} from "../../db/Drizzle.ts";
import {KarmaBump, Vote, VoteLive} from "./Vote.ts";

// A `Drizzle` whose every call throws — provided so that any path which actually
// reaches the DB seam fails the test. A guard that short-circuits before reading
// runs to completion against it, which is exactly the "no read" proof.
const throwingAccess: DrizzleAccess = {
	run: () => Effect.die(new Error("Vote read the DB on a path that must short-circuit")),
	batch: () => Effect.die(new Error("Vote wrote a batch on a path that must short-circuit")),
};

// A `Drizzle` whose `run` replays a queued sequence of results and whose `batch`
// throws — used to drive `cast`'s pre-batch decision (loadMeta + probe + cached
// score) while proving the idempotent no-op never reaches `batch`.
function scriptedAccess(results: ReadonlyArray<unknown>): {access: DrizzleAccess; runs: number} {
	const state = {i: 0};
	const access: DrizzleAccess = {
		run: <A>(fn: (db: DrizzleDb) => Promise<A>) => {
			void fn;
			const value = results[state.i++] as A;
			return Effect.succeed(value);
		},
		batch: () => Effect.die(new Error("idempotent no-op cast must not reach the batch")),
	};
	return {
		access,
		get runs() {
			return state.i;
		},
	};
}

const KarmaBumpStub = Layer.succeed(KarmaBump, {
	statement: () => {
		throw new Error("KarmaBump.statement must not be reached on a no-op cast");
	},
});

const voteLayer = (access: DrizzleAccess) =>
	VoteLive.pipe(Layer.provide(KarmaBumpStub), Layer.provide(Layer.succeed(Drizzle, access)));

describe("Vote.readMine — no-read short-circuit (mocked Drizzle seam)", () => {
	it.effect("empty ids → empty Set without touching the DB", () =>
		Effect.gen(function* () {
			const vote = yield* Vote;
			const voted = yield* vote.readMine("u1", "definition", []);
			assert.strictEqual(voted.size, 0);
		}).pipe(Effect.provide(voteLayer(throwingAccess))),
	);

	it.effect("null viewer → empty Set without touching the DB", () =>
		Effect.gen(function* () {
			const vote = yield* Vote;
			const voted = yield* vote.readMine(null, "definition", ["def-1"]);
			assert.strictEqual(voted.size, 0);
		}).pipe(Effect.provide(voteLayer(throwingAccess))),
	);

	it.effect("undefined viewer → empty Set without touching the DB", () =>
		Effect.gen(function* () {
			const vote = yield* Vote;
			const voted = yield* vote.readMine(undefined, "definition", ["def-1"]);
			assert.strictEqual(voted.size, 0);
		}).pipe(Effect.provide(voteLayer(throwingAccess))),
	);
});

describe("Vote.cast — pre-write decisions (mocked Drizzle seam)", () => {
	it.effect("a missing target raises VoteTargetNotFound before any write", () =>
		Effect.gen(function* () {
			const vote = yield* Vote;
			// loadMeta's findFirst resolves to `undefined` → not-found, no batch.
			const exit = yield* Effect.exit(
				vote.cast({userId: "u1", targetKind: "definition", targetId: "ghost", value: 1}),
			);
			assert.isTrue(exit._tag === "Failure", "cast against a missing target fails");
			assert.match(String(exit._tag === "Failure" ? exit.cause : ""), /VoteTargetNotFound/);
		}).pipe(Effect.provide(voteLayer(scriptedAccess([undefined]).access))),
	);

	it.effect("re-casting an already-cast vote is an idempotent no-op — no batch, no karma", () => {
		// run #1 loadMeta → a live target row; run #2 probeExisting → already cast;
		// run #3 readCachedScore → the cached score. The `batch` + KarmaBump stubs
		// throw, so reaching either fails the test.
		// loadMeta reads the row's `authorId`/`createdAt`; probeExisting + readCachedScore
		// return a bool + number directly (the queued values ARE each `run` fn's result).
		const row = {authorId: "author-1", createdAt: new Date()};
		const {access} = scriptedAccess([row, true, 7]);
		return Effect.gen(function* () {
			const vote = yield* Vote;
			const result = yield* vote.cast({
				userId: "voter-1",
				targetKind: "definition",
				targetId: "def-1",
				value: 1,
			});
			assert.isFalse(result.changed, "matching state is a no-op");
			assert.strictEqual(result.score, 7, "returns the cached score unchanged");
			assert.strictEqual(result.myVote, 1, "already-cast → myVote 1");
		}).pipe(Effect.provide(voteLayer(access)));
	});

	it.effect("retracting a never-cast vote is an idempotent no-op — no batch, no karma", () => {
		const row = {authorId: "author-1", createdAt: new Date()};
		const {access} = scriptedAccess([row, false, 0]);
		return Effect.gen(function* () {
			const vote = yield* Vote;
			const result = yield* vote.cast({
				userId: "voter-1",
				targetKind: "definition",
				targetId: "def-1",
				value: null,
			});
			assert.isFalse(result.changed, "matching state is a no-op");
			assert.strictEqual(result.score, 0);
			assert.isNull(result.myVote, "never-cast → myVote null");
		}).pipe(Effect.provide(voteLayer(access)));
	});
});

// A `Drizzle` that runs the batch builder against a stub db and records the
// produced statement array, so we can assert clearTarget's batch SHAPE (ADR 0096
// §3) without a real engine: exactly two statements (votes + user_vote), and —
// since KarmaBumpStub throws if reached — no karma statement.
function recordingBatchAccess(): {access: DrizzleAccess; batches: ReadonlyArray<unknown>[]} {
	const batches: ReadonlyArray<unknown>[] = [];
	// A db proxy whose every `.delete(...).where(...)` chain returns a marker. We
	// only count statements, so each chained call yields a chainable stand-in.
	const chainable: Record<string, (...a: unknown[]) => unknown> = {};
	const dbProxy: unknown = new Proxy(chainable, {
		get: () => () => dbProxy,
	});
	const access: DrizzleAccess = {
		run: () => Effect.die(new Error("clearTarget must not call run")),
		batch: <T extends Readonly<[unknown, ...unknown[]]>>(fn: (db: never) => T) => {
			const stmts = fn(dbProxy as never);
			batches.push(stmts as ReadonlyArray<unknown>);
			return Effect.succeed([] as never);
		},
	};
	return {access, batches};
}

describe("Vote.clearTarget — cleanup batch shape (ADR 0096 §3, mocked Drizzle seam)", () => {
	for (const kind of ["definition", "post", "comment"] as const) {
		it.effect(`${kind}: one batch of exactly two statements, karma KEPT`, () => {
			const {access, batches} = recordingBatchAccess();
			return Effect.gen(function* () {
				const vote = yield* Vote;
				yield* vote.clearTarget(kind, "target-1");
				assert.strictEqual(batches.length, 1, "clearTarget is one atomic batch");
				assert.strictEqual(
					batches[0]?.length,
					2,
					"votes + user_vote only — no karma decrement (karma KEPT)",
				);
				// KarmaBumpStub throws if its `statement` is ever read; reaching here
				// proves clearTarget never touched karma.
			}).pipe(Effect.provide(voteLayer(access)));
		});
	}
});
