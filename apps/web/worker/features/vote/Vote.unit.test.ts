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
import {TARGET_KINDS} from "../../db/target-kind.ts";
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
				vote.cast({userId: "u1", targetKind: "definition", targetId: "ghost", value: true}),
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
				value: true,
			});
			assert.isFalse(result.changed, "matching state is a no-op");
			assert.strictEqual(result.score, 7, "returns the cached score unchanged");
			assert.isTrue(result.myVote, "already-cast → myVote true");
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
				value: false,
			});
			assert.isFalse(result.changed, "matching state is a no-op");
			assert.strictEqual(result.score, 0);
			assert.isFalse(result.myVote, "never-cast → myVote false");
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

// A recording write-path seam: `run` replays the pre/post-batch reads (loadMeta,
// probe, post-batch score) and `batch` records the produced statement array against a
// chainable db proxy, so a state-changing cast can be asserted (it reaches the write and
// its batch carries the karma statement) without a real engine.
function recordingCastAccess(reads: ReadonlyArray<unknown>): {
	access: DrizzleAccess;
	batches: ReadonlyArray<unknown>[];
} {
	const state = {i: 0};
	const batches: ReadonlyArray<unknown>[] = [];
	const chainable: Record<string, (...a: unknown[]) => unknown> = {};
	const dbProxy: unknown = new Proxy(chainable, {get: () => () => dbProxy});
	const access: DrizzleAccess = {
		run: <A>(fn: (db: DrizzleDb) => Promise<A>) => {
			void fn;
			return Effect.succeed(reads[state.i++] as A);
		},
		batch: <T extends Readonly<[unknown, ...unknown[]]>>(fn: (db: never) => T) => {
			batches.push(fn(dbProxy as never) as ReadonlyArray<unknown>);
			return Effect.succeed([] as never);
		},
	};
	return {access, batches};
}

// A KarmaBump that RECORDS each bump (recipient + delta) and returns a sentinel
// statement, so a cast's karma credit is observable: who got karma and by how much.
function recordingKarma(): {
	layer: Layer.Layer<KarmaBump>;
	calls: {userId: string; delta: number}[];
} {
	const calls: {userId: string; delta: number}[] = [];
	const layer = Layer.succeed(KarmaBump, {
		statement: ((_db: unknown, userId: string, delta: number) => {
			calls.push({userId, delta});
			return {__karma: true} as never;
		}) as KarmaBump["Service"]["statement"],
	});
	return {layer, calls};
}

const sandboxedMeta = {authorId: "caylak-1", createdAtMs: 0, sandboxed: true};
const liveMeta = {authorId: "author-1", createdAtMs: 0, sandboxed: false};

describe("Vote.cast — sandbox eligibility (#1288, mocked Drizzle seam)", () => {
	it.effect("cast REJECTS a sandboxed target with VoteTargetSandboxed before any write", () =>
		// loadMeta → a still-sandboxed row; the eligibility guard short-circuits before the
		// probe/batch (the throwing batch proves no write).
		Effect.gen(function* () {
			const vote = yield* Vote;
			const exit = yield* Effect.exit(
				vote.cast({userId: "voter-1", targetKind: "definition", targetId: "def-sb", value: true}),
			);
			assert.isTrue(exit._tag === "Failure", "cast on a sandboxed target fails");
			assert.match(String(exit._tag === "Failure" ? exit.cause : ""), /VoteTargetSandboxed/);
		}).pipe(Effect.provide(voteLayer(scriptedAccess([sandboxedMeta]).access))),
	);

	it.effect("castOnSandboxed ACCEPTS a sandboxed target — scores + credits the author", () => {
		// reads: loadMeta (sandboxed) → probe (not yet cast) → post-batch score. The cast
		// reaches the atomic batch; the recording karma proves +1 credited to the AUTHOR.
		const {access, batches} = recordingCastAccess([sandboxedMeta, false, 1]);
		const {layer: karma, calls} = recordingKarma();
		return Effect.gen(function* () {
			const vote = yield* Vote;
			const result = yield* vote.castOnSandboxed({
				userId: "yazar-1",
				targetKind: "definition",
				targetId: "def-sb",
				value: true,
			});
			assert.isTrue(result.changed, "the sandboxed vote is a real state change");
			assert.strictEqual(result.score, 1);
			assert.strictEqual(batches.length, 1, "scoring + karma land in one atomic batch (ADR 0014)");
			assert.strictEqual(batches[0]?.length, 4, "vote + score-cache + user_vote + karma");
			assert.deepStrictEqual(
				calls,
				[{userId: "caylak-1", delta: 1}],
				"karma credited to the content author, +1 (D2 global karma, D3 equal weight)",
			);
		}).pipe(
			Effect.provide(
				VoteLive.pipe(Layer.provide(karma), Layer.provide(Layer.succeed(Drizzle, access))),
			),
		);
	});

	it.effect("cast on a LIVE target is unaffected — the inline path still scores + credits", () => {
		const {access, batches} = recordingCastAccess([liveMeta, false, 1]);
		const {layer: karma, calls} = recordingKarma();
		return Effect.gen(function* () {
			const vote = yield* Vote;
			const result = yield* vote.cast({
				userId: "voter-1",
				targetKind: "definition",
				targetId: "def-live",
				value: true,
			});
			assert.isTrue(result.changed);
			assert.strictEqual(batches[0]?.length, 4, "live vote still writes the full batch");
			assert.deepStrictEqual(calls, [{userId: "author-1", delta: 1}]);
		}).pipe(
			Effect.provide(
				VoteLive.pipe(Layer.provide(karma), Layer.provide(Layer.succeed(Drizzle, access))),
			),
		);
	});
});

describe("Vote.clearTarget — cleanup batch shape (ADR 0096 §3, mocked Drizzle seam)", () => {
	for (const kind of TARGET_KINDS) {
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
