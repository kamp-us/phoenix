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
import {wireCodeOfClass} from "@kampus/fate-effect";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess, type DrizzleDb} from "../../db/Drizzle.ts";
import {TARGET_KINDS} from "../../db/target-kind.ts";
import type {TelemetryEvent} from "../telemetry/schema.ts";
import {Telemetry} from "../telemetry/Telemetry.ts";
import {VOTE_ELIGIBILITY_WIRE_CODE, VOTE_REQUIRED_TIER, VoterNotEligible} from "./errors.ts";
import {KarmaBump, type KarmaBumpInput, Vote, VoteLive, VoterStanding} from "./Vote.ts";

// A recording `Telemetry` seam: `emit` pushes each event into `sink` and succeeds,
// so a test can assert the exact `{feature, action, surface, userId}` a cast emitted
// — and that a rejected/no-op cast emits nothing (empty sink). Substitutes the
// `Telemetry` tag directly (`.patterns/effect-testing.md`), no real Analytics Engine.
const recordingTelemetry = (sink: TelemetryEvent[]) =>
	Layer.succeed(Telemetry, {
		emit: (event) =>
			Effect.sync(() => {
				sink.push(event);
			}),
	});

// A `Telemetry` whose `emit` DIES — the commit-ordering double. The real `TelemetryLive`
// discharges the WHOLE Cause internally (`Effect.ignoreCause`, #2085) so `emit` is `Effect<void>`
// and a defect can never surface; substituting the tag with this dying double bypasses that
// seam, so it can only prove the cast is committed BEFORE the emit runs (the seam-level S4 proof
// itself lives in `Telemetry.unit.test.ts`), never fed through the real containment.
const failingTelemetry = Layer.succeed(Telemetry, {
	emit: () => Effect.die(new Error("telemetry emit blew up — off the commit path")),
});

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
	statements: () => {
		throw new Error("KarmaBump.statements must not be reached on a no-op cast");
	},
});

// A `VoterStanding` stub with a fixed eligibility verdict. `eligible` (the default) is
// the "voter is above the çaylak floor" case, so tests NOT exercising the tier gate see
// their prior behaviour; `caylak` (below the floor) drives the #1810 gate rejection.
const VoterStandingStub = (aboveNewcomer: boolean) =>
	Layer.succeed(VoterStanding, {isAboveNewcomer: () => Effect.succeed(aboveNewcomer)});

const voteLayer = (
	access: DrizzleAccess,
	aboveNewcomer = true,
	telemetry: Layer.Layer<Telemetry> = recordingTelemetry([]),
) =>
	VoteLive.pipe(
		Layer.provide(KarmaBumpStub),
		Layer.provide(VoterStandingStub(aboveNewcomer)),
		Layer.provide(telemetry),
		Layer.provide(Layer.succeed(Drizzle, access)),
	);

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

// A KarmaBump that RECORDS each bump's full context and returns the TWO sentinel
// statements the real contract now emits (the `total_karma` bump + its `karma_event`
// provenance row, #2592), so a cast's karma credit is observable: who got karma, by how
// much, from which source, and why. `calls` keeps the recipient+delta shape prior
// assertions read; `inputs` exposes the source/reason/timestamp the ledger row carries.
function recordingKarma(): {
	layer: Layer.Layer<KarmaBump>;
	calls: {userId: string; delta: number}[];
	inputs: KarmaBumpInput[];
} {
	const calls: {userId: string; delta: number}[] = [];
	const inputs: KarmaBumpInput[] = [];
	const layer = Layer.succeed(KarmaBump, {
		statements: ((_db: unknown, input: KarmaBumpInput) => {
			inputs.push(input);
			calls.push({userId: input.recipientId, delta: input.delta});
			return [{__karmaBump: true}, {__karmaEvent: true}] as never;
		}) as KarmaBump["Service"]["statements"],
	});
	return {layer, calls, inputs};
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
		const {layer: karma, calls, inputs} = recordingKarma();
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
			assert.strictEqual(
				batches[0]?.length,
				5,
				"vote + score-cache + user_vote + karma-bump + karma-event (#2592: the ledger row co-commits)",
			);
			assert.deepStrictEqual(
				calls,
				[{userId: "caylak-1", delta: 1}],
				"karma credited to the content author, +1 (D2 global karma, D3 equal weight)",
			);
			// The provenance the ledger row records: source target + reason (#2592).
			assert.deepStrictEqual(inputs[0]?.source, {kind: "definition", id: "def-sb"});
			assert.strictEqual(inputs[0]?.reason, "vote");
		}).pipe(
			Effect.provide(
				VoteLive.pipe(
					Layer.provide(karma),
					// Voter above the çaylak floor — the #1810 tier gate is not what these two
					// tests exercise (divan path has it OFF; the live path is a promoted voter).
					Layer.provide(VoterStandingStub(true)),
					Layer.provide(recordingTelemetry([])),
					Layer.provide(Layer.succeed(Drizzle, access)),
				),
			),
		);
	});

	it.effect("cast on a LIVE target is unaffected — the inline path still scores + credits", () => {
		const {access, batches} = recordingCastAccess([liveMeta, false, 1]);
		const {layer: karma, calls, inputs} = recordingKarma();
		return Effect.gen(function* () {
			const vote = yield* Vote;
			const result = yield* vote.cast({
				userId: "voter-1",
				targetKind: "definition",
				targetId: "def-live",
				value: true,
			});
			assert.isTrue(result.changed);
			assert.strictEqual(
				batches[0]?.length,
				5,
				"live vote still writes the full batch + ledger row",
			);
			assert.deepStrictEqual(calls, [{userId: "author-1", delta: 1}]);
			assert.deepStrictEqual(inputs[0]?.source, {kind: "definition", id: "def-live"});
			assert.strictEqual(inputs[0]?.reason, "vote");
		}).pipe(
			Effect.provide(
				VoteLive.pipe(
					Layer.provide(karma),
					// Voter above the çaylak floor — the #1810 tier gate is not what these two
					// tests exercise (divan path has it OFF; the live path is a promoted voter).
					Layer.provide(VoterStandingStub(true)),
					Layer.provide(recordingTelemetry([])),
					Layer.provide(Layer.succeed(Drizzle, access)),
				),
			),
		);
	});
});

describe("Vote.cast — voter-tier gate ('earn to vote', #1810, mocked Drizzle seam)", () => {
	// The three inline cast paths (pano post/comment + sözlük definition) all reach the
	// single `Vote.castImpl` choke point via `cast`. A çaylak (below-floor) voter is
	// rejected on EACH before any DB read — the throwing `Drizzle` proves the short-circuit
	// runs ahead of `loadMeta`, so the gate never even looks at the target.
	for (const kind of TARGET_KINDS) {
		it.effect(
			`${kind}: a çaylak (below-floor) voter is REJECTED with VoterNotEligible — no DB read`,
			() =>
				Effect.gen(function* () {
					const vote = yield* Vote;
					const err = yield* Effect.flip(
						vote.cast({
							userId: "caylak-voter",
							targetKind: kind,
							targetId: `${kind}-1`,
							value: true,
						}),
					);
					// `flip` surfaces the typed error as the success channel so we assert on the
					// `VoterNotEligible` instance itself — its `need` bar comes from the single
					// source (Vote no longer re-bakes a raw tier string, the #2021 contract).
					assert.isTrue(
						err instanceof VoterNotEligible,
						"a çaylak cast fails with VoterNotEligible",
					);
					if (err instanceof VoterNotEligible) {
						assert.strictEqual(err.need, VOTE_REQUIRED_TIER);
					}
				}).pipe(Effect.provide(voteLayer(throwingAccess, false))),
		);
	}

	it("VoterNotEligible.need + its wire code are single-sourced from VOTE_REQUIRED_TIER (#2021)", () => {
		// The tier name and the wire code are ONE fact: the error's `need` is `VOTE_REQUIRED_TIER`
		// and its `FateWireCode` is derived from it, so a ladder move can't drift them apart.
		const err = new VoterNotEligible({voterId: "u1", need: VOTE_REQUIRED_TIER, message: "x"});
		assert.strictEqual(err.need, VOTE_REQUIRED_TIER);
		assert.strictEqual(
			VOTE_ELIGIBILITY_WIRE_CODE,
			`VOTE_REQUIRES_${VOTE_REQUIRED_TIER.toUpperCase()}`,
		);
		// The annotation on the error class reads back the derived code, not a hand-typed literal.
		assert.strictEqual(wireCodeOfClass(VoterNotEligible), VOTE_ELIGIBILITY_WIRE_CODE);
		// With the current ladder rank the derived code is the literal the SPA copy decodes.
		assert.strictEqual(VOTE_ELIGIBILITY_WIRE_CODE, "VOTE_REQUIRES_YAZAR");
	});

	it.effect("a promoted (above-floor) voter still casts normally on a live target", () => {
		// reads: loadMeta (live) → probe (not yet cast) → post-batch score. The eligible voter
		// clears the gate and the cast reaches the atomic batch (+1 to the author).
		const {access, batches} = recordingCastAccess([liveMeta, false, 1]);
		const {layer: karma, calls} = recordingKarma();
		return Effect.gen(function* () {
			const vote = yield* Vote;
			const result = yield* vote.cast({
				userId: "yazar-voter",
				targetKind: "definition",
				targetId: "def-live",
				value: true,
			});
			assert.isTrue(result.changed, "a promoted voter's cast is a real state change");
			assert.strictEqual(batches[0]?.length, 5, "the full vote batch + ledger row still writes");
			assert.deepStrictEqual(calls, [{userId: "author-1", delta: 1}], "author credited +1");
		}).pipe(
			Effect.provide(
				VoteLive.pipe(
					Layer.provide(karma),
					Layer.provide(VoterStandingStub(true)),
					Layer.provide(recordingTelemetry([])),
					Layer.provide(Layer.succeed(Drizzle, access)),
				),
			),
		);
	});

	it.effect(
		"a çaylak RETRACTING is not tier-gated — a retraction removes influence, never adds",
		() => {
			// A çaylak has no cast to retract in practice, but the gate is CAST-direction-only:
			// `value: false` skips it. Here the retraction is an idempotent no-op (never-cast),
			// so it returns cleanly with `changed: false` rather than raising VoterNotEligible.
			const {access} = scriptedAccess([liveMeta, false, 0]);
			return Effect.gen(function* () {
				const vote = yield* Vote;
				const result = yield* vote.cast({
					userId: "caylak-voter",
					targetKind: "post",
					targetId: "post-1",
					value: false,
				});
				assert.isFalse(result.changed, "retraction of a never-cast vote is a clean no-op");
			}).pipe(Effect.provide(voteLayer(access, false)));
		},
	);

	it.effect(
		"the target-liveness gate still holds — an eligible voter is rejected on a sandboxed target",
		() =>
			// An above-floor voter clears the tier gate but the target is sandboxed, so the
			// EXISTING VoteTargetSandboxed gate (#1288) still fires: both gates compose.
			Effect.gen(function* () {
				const vote = yield* Vote;
				const exit = yield* Effect.exit(
					vote.cast({
						userId: "yazar-voter",
						targetKind: "definition",
						targetId: "def-sb",
						value: true,
					}),
				);
				assert.isTrue(exit._tag === "Failure", "cast on a sandboxed target still fails");
				assert.match(String(exit._tag === "Failure" ? exit.cause : ""), /VoteTargetSandboxed/);
			}).pipe(Effect.provide(voteLayer(scriptedAccess([sandboxedMeta]).access, true))),
	);
});

describe("Vote.cast — karma provenance ledger (#2592, mocked Drizzle seam)", () => {
	it.effect("a real retraction co-commits a -1 ledger event with reason 'retract'", () => {
		// reads: loadMeta (live) → probe (already cast) → post-batch score. `value:false` on an
		// existing vote is a state change, so it reaches the batch with karmaDelta -1 — and the
		// ledger row records the negative delta as an event, never a deletion (append-only).
		const {access, batches} = recordingCastAccess([liveMeta, true, 0]);
		const {layer: karma, calls, inputs} = recordingKarma();
		return Effect.gen(function* () {
			const vote = yield* Vote;
			const result = yield* vote.cast({
				userId: "voter-1",
				targetKind: "post",
				targetId: "post-9",
				value: false,
			});
			assert.isTrue(result.changed, "retracting an existing vote is a real state change");
			assert.strictEqual(batches[0]?.length, 5, "retraction batch still carries the ledger row");
			assert.deepStrictEqual(calls, [{userId: "author-1", delta: -1}], "author debited -1");
			assert.deepStrictEqual(inputs[0]?.source, {kind: "post", id: "post-9"});
			assert.strictEqual(inputs[0]?.reason, "retract");
			assert.strictEqual(inputs[0]?.delta, -1, "the ledger event carries the negative delta");
		}).pipe(
			Effect.provide(
				VoteLive.pipe(
					Layer.provide(karma),
					Layer.provide(VoterStandingStub(true)),
					Layer.provide(recordingTelemetry([])),
					Layer.provide(Layer.succeed(Drizzle, access)),
				),
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

// Reference instrument #1 (ADR 0153, epic #2065, #2068): `Vote.cast` emits a `vote`
// telemetry event after a committed cast. Recording/failing `Telemetry` doubles at the
// tag prove: the emit carries the right positional fields, fires ONLY on a committed
// state change (never on a no-op or a rejected cast), distinguishes cast vs retract, and
// — S4 fail-safe — can never fail the vote even when the seam itself blows up.
describe("Vote.cast — telemetry instrument (ADR 0153, #2068, mocked Drizzle + Telemetry seams)", () => {
	// Build a VoteLive whose Telemetry is the given double and whose write-path Drizzle is a
	// recording cast access, so a state-changing cast reaches the emit.
	const instrumentLayer = (access: DrizzleAccess, telemetry: Layer.Layer<Telemetry>) => {
		const {layer: karma} = recordingKarma();
		return VoteLive.pipe(
			Layer.provide(karma),
			Layer.provide(VoterStandingStub(true)),
			Layer.provide(telemetry),
			Layer.provide(Layer.succeed(Drizzle, access)),
		);
	};

	it.effect(
		"a committed live cast emits exactly one {vote, cast, <targetKind>, userId} event",
		() => {
			const {access} = recordingCastAccess([liveMeta, false, 1]);
			const sink: TelemetryEvent[] = [];
			return Effect.gen(function* () {
				const vote = yield* Vote;
				yield* vote.cast({userId: "voter-1", targetKind: "post", targetId: "post-1", value: true});
				assert.strictEqual(sink.length, 1, "exactly one event per committed cast");
				assert.deepStrictEqual(sink[0], {
					feature: "vote",
					action: "cast",
					surface: "post",
					userId: "voter-1",
				});
			}).pipe(Effect.provide(instrumentLayer(access, recordingTelemetry(sink))));
		},
	);

	it.effect("a committed retract emits action:'retract' (cast vs retract distinguished)", () => {
		// probe → already cast (true), so `value:false` is a real state change (retraction).
		const {access} = recordingCastAccess([liveMeta, true, 0]);
		const sink: TelemetryEvent[] = [];
		return Effect.gen(function* () {
			const vote = yield* Vote;
			const result = yield* vote.cast({
				userId: "voter-1",
				targetKind: "definition",
				targetId: "def-1",
				value: false,
			});
			assert.isTrue(result.changed, "an existing vote is really retracted");
			assert.strictEqual(sink.length, 1);
			assert.deepStrictEqual(sink[0], {
				feature: "vote",
				action: "retract",
				surface: "definition",
				userId: "voter-1",
			});
		}).pipe(Effect.provide(instrumentLayer(access, recordingTelemetry(sink))));
	});

	it.effect("an idempotent no-op cast emits NOTHING (emit is off the no-write path)", () => {
		// probe → already cast, and `value:true` matches → no batch, no emit.
		const {access} = scriptedAccess([liveMeta, true, 5]);
		const sink: TelemetryEvent[] = [];
		return Effect.gen(function* () {
			const vote = yield* Vote;
			const result = yield* vote.cast({
				userId: "voter-1",
				targetKind: "definition",
				targetId: "def-1",
				value: true,
			});
			assert.isFalse(result.changed, "matching state is a no-op");
			assert.strictEqual(sink.length, 0, "a no-op cast records no telemetry");
		}).pipe(Effect.provide(instrumentLayer(access, recordingTelemetry(sink))));
	});

	it.effect("a rejected cast (target-not-found) emits NOTHING", () => {
		// loadMeta → undefined → VoteTargetNotFound before any write, so no emit.
		const {access} = scriptedAccess([undefined]);
		const sink: TelemetryEvent[] = [];
		return Effect.gen(function* () {
			const vote = yield* Vote;
			const exit = yield* Effect.exit(
				vote.cast({userId: "voter-1", targetKind: "definition", targetId: "ghost", value: true}),
			);
			assert.isTrue(exit._tag === "Failure", "the cast is rejected");
			assert.strictEqual(sink.length, 0, "a rejected cast records no telemetry");
		}).pipe(Effect.provide(instrumentLayer(access, recordingTelemetry(sink))));
	});

	it.effect("a rejected cast (voter-not-eligible) emits NOTHING", () => {
		// Below-floor voter → VoterNotEligible before any DB read, so no emit. The throwing
		// Drizzle proves the short-circuit; the recording Telemetry proves the reject path
		// never reaches the emit.
		const sink: TelemetryEvent[] = [];
		return Effect.gen(function* () {
			const vote = yield* Vote;
			const err = yield* Effect.flip(
				vote.cast({userId: "caylak-voter", targetKind: "post", targetId: "post-1", value: true}),
			);
			assert.isTrue(err instanceof VoterNotEligible);
			assert.strictEqual(sink.length, 0, "a below-floor rejected cast records no telemetry");
		}).pipe(
			Effect.provide(
				VoteLive.pipe(
					Layer.provide(KarmaBumpStub),
					Layer.provide(VoterStandingStub(false)),
					Layer.provide(recordingTelemetry(sink)),
					Layer.provide(Layer.succeed(Drizzle, throwingAccess)),
				),
			),
		);
	});

	it.effect("the emit is off the commit path — the cast commits before the emit runs", () => {
		// The `Telemetry` double's `emit` DIES. The vote batch is sequenced BEFORE the emit,
		// so its statement is already in `batches` (the cast committed) even as the emit blows
		// up — proving the emit is downstream of the commit, never a gate on it. Since #2085
		// the vote emits BARE (no call-site wrap): the production fail-safe that turns a defect
		// into a swallowed no-op lives in `TelemetryLive` (`Effect.ignoreCause`) and is pinned
		// seam-side in `Telemetry.unit.test.ts`; this double substitutes the `Telemetry` tag so
		// it never reaches that seam, and here we only assert the commit-before-emit ordering.
		const {access, batches} = recordingCastAccess([liveMeta, false, 1]);
		return Effect.gen(function* () {
			const vote = yield* Vote;
			yield* Effect.exit(
				vote.cast({
					userId: "voter-1",
					targetKind: "definition",
					targetId: "def-live",
					value: true,
				}),
			);
			assert.strictEqual(batches.length, 1, "the vote batch committed before the emit");
		}).pipe(Effect.provide(instrumentLayer(access, failingTelemetry)));
	});
});
