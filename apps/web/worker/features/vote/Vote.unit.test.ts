/**
 * Vote unit coverage — the decisions that are wrong-or-right with no database
 * (ADR 0082). Throughout, a `run`/`batch` that THROWS is the proof that a
 * short-circuit never touched the DB. Vote's real-D1 fidelity (composite-PK
 * idempotency, aggregate counters, soft-delete, the cast round-trip) lives in
 * `tests/integration/`.
 */
import {assert, describe, it} from "@effect/vitest";
import {wireCodeOfClass} from "@kampus/fate-effect";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess, type DrizzleDb} from "../../db/Drizzle.ts";
import {TARGET_KINDS} from "../../db/target-kind.ts";
import {UserId} from "../../lib/ids.ts";
import type {TelemetryEvent} from "../telemetry/schema.ts";
import {Telemetry} from "../telemetry/Telemetry.ts";
import {VOTE_ELIGIBILITY_WIRE_CODE, VOTE_REQUIRED_TIER, VoterNotEligible} from "./errors.ts";
import {KarmaBump, type KarmaBumpInput, Vote, VoteLive, VoterStanding} from "./Vote.ts";

// Substitutes the `Telemetry` tag directly (.patterns/effect-testing.md) — an empty
// `sink` is the proof that a rejected or no-op cast emitted nothing.
const recordingTelemetry = (sink: TelemetryEvent[]) =>
	Layer.succeed(Telemetry, {
		emit: (event) =>
			Effect.sync(() => {
				sink.push(event);
			}),
	});

// A `Telemetry` whose `emit` DIES. Substituting the tag bypasses `TelemetryLive`'s own
// `Effect.ignoreCause` containment (#2085), so this can only prove commit-before-emit
// ordering — the S4 containment proof itself lives in `Telemetry.unit.test.ts`.
const failingTelemetry = Layer.succeed(Telemetry, {
	emit: () => Effect.die(new Error("telemetry emit blew up — off the commit path")),
});

// Every call throws on purpose: any path that reaches the DB seam fails the test, so
// running to completion against it IS the "no read" proof.
const throwingAccess: DrizzleAccess = {
	run: () => Effect.die(new Error("Vote read the DB on a path that must short-circuit")),
	batch: () => Effect.die(new Error("Vote wrote a batch on a path that must short-circuit")),
};

// `run` replays a queued sequence of results; `batch` throws, so an idempotent no-op
// that reaches the write fails the test.
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

// `eligible` (the default) is above the çaylak floor; `caylak` is below it and drives
// the #1810 gate rejection.
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
			const exit = yield* Effect.exit(
				vote.cast({userId: "u1", targetKind: "definition", targetId: "ghost", value: true}),
			);
			assert.isTrue(exit._tag === "Failure", "cast against a missing target fails");
			assert.match(String(exit._tag === "Failure" ? exit.cause : ""), /VoteTargetNotFound/);
		}).pipe(Effect.provide(voteLayer(scriptedAccess([undefined]).access))),
	);

	it.effect("re-casting an already-cast vote is an idempotent no-op — no batch, no karma", () => {
		// The queued values ARE each `run` fn's result, in call order: loadMeta row,
		// probeExisting bool, readCachedScore number.
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

// Records the statement array the batch builder produces, so clearTarget's batch SHAPE
// (ADR 0096 §3) is assertable without an engine.
function recordingBatchAccess(): {access: DrizzleAccess; batches: ReadonlyArray<unknown>[]} {
	const batches: ReadonlyArray<unknown>[] = [];
	// Only statement COUNT matters here, so every chained db call yields a stand-in.
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

// `run` replays the pre/post-batch reads and `batch` records the produced statements,
// so a state-changing cast is assertable without an engine.
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

// Returns the TWO sentinel statements the real contract emits (the `total_karma` bump
// plus its `karma_event` provenance row, #2592). `calls` carries recipient+delta,
// `inputs` the source/reason/timestamp the ledger row records.
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
		// The eligibility guard short-circuits before the probe/batch; the throwing batch
		// proves no write.
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
		// reads: loadMeta (sandboxed) → probe (not yet cast) → post-batch score.
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
			assert.deepStrictEqual(inputs[0]?.source, {kind: "definition", id: "def-sb"});
			assert.strictEqual(inputs[0]?.reason, "vote");
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
					Layer.provide(VoterStandingStub(true)),
					Layer.provide(recordingTelemetry([])),
					Layer.provide(Layer.succeed(Drizzle, access)),
				),
			),
		);
	});
});

describe("Vote.cast — voter-tier gate ('earn to vote', #1810, mocked Drizzle seam)", () => {
	// All three inline cast paths funnel through the one `Vote.castImpl` choke point, so
	// each is checked here; the throwing `Drizzle` proves the gate runs ahead of `loadMeta`.
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
					// `flip` moves the typed error into the success channel so the instance
					// itself is assertable.
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
		// The tier name and the wire code are ONE fact — the code is derived from `need`, so
		// a ladder move can't drift them apart.
		const err = new VoterNotEligible({
			voterId: UserId.make("u1"),
			need: VOTE_REQUIRED_TIER,
			message: "x",
		});
		assert.strictEqual(err.need, VOTE_REQUIRED_TIER);
		assert.strictEqual(
			VOTE_ELIGIBILITY_WIRE_CODE,
			`VOTE_REQUIRES_${VOTE_REQUIRED_TIER.toUpperCase()}`,
		);
		assert.strictEqual(wireCodeOfClass(VoterNotEligible), VOTE_ELIGIBILITY_WIRE_CODE);
		// At the current ladder rank the derived code is the literal the SPA copy decodes.
		assert.strictEqual(VOTE_ELIGIBILITY_WIRE_CODE, "VOTE_REQUIRES_YAZAR");
	});

	it.effect("a promoted (above-floor) voter still casts normally on a live target", () => {
		// reads: loadMeta (live) → probe (not yet cast) → post-batch score.
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
			// The tier gate is CAST-direction-only, so `value: false` skips it — a çaylak
			// retraction returns `changed: false` rather than raising VoterNotEligible.
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
			// Both gates compose: clearing the tier floor does not clear #1288's sandbox gate.
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
		// reads: loadMeta (live) → probe (already cast) → post-batch score. The ledger records
		// the -1 as an event, never a deletion (append-only).
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

describe("Vote.cast — the guarded karma pair leads the batch (#2552, mocked Drizzle seam)", () => {
	// The karma pair is gated on the vote row's PRE-mutation presence, which is only
	// correct if karma is evaluated BEFORE the vote-row write in the batch. These tests pin
	// that ordering: the karma sentinels must lead `batches[0]`.
	it.effect(
		"karma bump + ledger row are the first two batch statements, and carry the guard",
		() => {
			const {access, batches} = recordingCastAccess([liveMeta, false, 1]);
			const {layer: karma, inputs} = recordingKarma();
			return Effect.gen(function* () {
				const vote = yield* Vote;
				yield* vote.cast({
					userId: "voter-1",
					targetKind: "definition",
					targetId: "def-1",
					value: true,
				});
				const stmts = batches[0] as ReadonlyArray<{__karmaBump?: true; __karmaEvent?: true}>;
				assert.strictEqual(stmts.length, 5, "the full atomic batch");
				assert.isTrue(
					stmts[0]?.__karmaBump,
					"the karma bump is sequenced first (pre-mutation guard)",
				);
				assert.isTrue(stmts[1]?.__karmaEvent, "its ledger row is second — ahead of the vote write");
				assert.isDefined(
					inputs[0]?.guard,
					"Vote threads the pre-mutation vote-change guard through",
				);
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
		},
	);
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

// Reference instrument #1 — see ADR 0153 (epic #2065, #2068).
describe("Vote.cast — telemetry instrument (ADR 0153, #2068, mocked Drizzle + Telemetry seams)", () => {
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
		// The throwing Drizzle proves the short-circuit; the empty sink proves the reject
		// path never reaches the emit.
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
		// The batch is already recorded even as the dying emit blows up, which is the proof
		// that the emit is downstream of the commit. Since #2085 the vote emits BARE — the
		// fail-safe lives in `TelemetryLive` and is pinned in `Telemetry.unit.test.ts`, so
		// this substituted double can only show the ordering.
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
