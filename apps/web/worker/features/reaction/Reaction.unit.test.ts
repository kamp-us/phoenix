/**
 * Reaction unit coverage — the decisions that are wrong-or-right with no
 * database (ADR 0082). The `Drizzle` seam is substituted directly (the
 * `Vote.unit.test.ts` idiom): a `run`/`batch` that THROWS proves a short-circuit
 * never touched the DB, a stubbed `run` feeds the decision its inputs, and a
 * recording `batch` captures the produced statement array so the write SHAPE is
 * asserted without an engine. Reaction's real-D1 fidelity — composite-PK upsert
 * (the emoji changes in place, still one row), retract removes the row,
 * soft-delete not-found — lives on real D1 in `tests/integration/`.
 *
 * The load-bearing divergence from Vote is proven structurally here: the
 * `ReactionLive` layer is built with NO `KarmaBump` and NO `VoterStanding`
 * dependency — the react tests below drive `react` to completion against a layer
 * that provides only `Drizzle`, so a çaylak (any user) reacting reaches the write
 * with no tier gate and no karma statement. Reactions are ungated and karma-free.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import * as Schema from "effect/Schema";
import {Drizzle, type DrizzleAccess, type DrizzleDb} from "../../db/Drizzle.ts";
import {REACTION_EMOJI, ReactionEmojiSchema} from "../../db/reaction-emoji.ts";
import {TARGET_KINDS} from "../../db/target-kind.ts";
import type {TelemetryEvent} from "../telemetry/schema.ts";
import {dyingTelemetry, recordingTelemetry} from "../telemetry/Telemetry.testing.ts";
import type {Telemetry} from "../telemetry/Telemetry.ts";
import {Reaction, ReactionLive} from "./Reaction.ts";

// A `Drizzle` whose every call throws — any path that actually reaches the DB
// seam fails the test. A guard that short-circuits before reading runs to
// completion against it, the "no read" proof.
const throwingAccess: DrizzleAccess = {
	run: () => Effect.die(new Error("Reaction read the DB on a path that must short-circuit")),
	batch: () => Effect.die(new Error("Reaction wrote a batch on a path that must short-circuit")),
};

// A `Drizzle` whose `run` replays a queued sequence of results and whose `batch`
// throws — drives `react`'s pre-batch decision (assertTargetLive + probe) while
// proving the idempotent no-op never reaches `batch`.
function scriptedAccess(results: ReadonlyArray<unknown>): DrizzleAccess {
	const state = {i: 0};
	return {
		run: <A>(fn: (db: DrizzleDb) => Promise<A>) => {
			void fn;
			return Effect.succeed(results[state.i++] as A);
		},
		batch: () => Effect.die(new Error("idempotent no-op react must not reach the batch")),
	};
}

// A recording write-path seam: `run` replays the pre-batch reads (assertTargetLive
// meta, probe) and `batch` records the produced statement array against a chainable
// db proxy, so a state-changing react is asserted (it reaches the write, its batch
// carries exactly one statement) without a real engine.
function recordingAccess(reads: ReadonlyArray<unknown>): {
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

// The Reaction layer under test. It provides `Drizzle` and `Telemetry` (the
// product-usage seam `Reaction.react` emits through, #2069). There is still NO
// KarmaBump and NO VoterStanding to provide, because Reaction declares neither
// (the ungated, karma-free divergence from Vote) — that the layer builds without
// them IS the "no tier gate, no karma" proof at the seam. `telemetry` defaults to
// a discarding recording sink so the react/change/no-op/retract write tests need
// no telemetry setup; the emit tests pass a recording sink or the dying double.
const reactionLayer = (
	access: DrizzleAccess,
	telemetry: Layer.Layer<Telemetry> = recordingTelemetry([]),
) => ReactionLive.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Drizzle, access), telemetry)));

// A live target meta the descriptor's loadMeta returns (author/createdAt/sandboxed
// are Vote's fields; Reaction reads none of them — it only needs existence).
const liveMeta = {authorId: "author-1", createdAtMs: 0, sandboxed: false};
// A sandboxed target — Reaction reacts to it like any other live row (ungated).
const sandboxedMeta = {authorId: "caylak-1", createdAtMs: 0, sandboxed: true};

describe("Reaction.react — target liveness (mocked Drizzle seam)", () => {
	it.effect("a missing/removed target raises ReactionTargetNotFound before any write", () =>
		Effect.gen(function* () {
			const reaction = yield* Reaction;
			// assertTargetLive's loadMeta resolves to `undefined` → not-found, no batch.
			const exit = yield* Effect.exit(
				reaction.react({userId: "u1", targetKind: "definition", targetId: "ghost", emoji: "👍"}),
			);
			assert.isTrue(exit._tag === "Failure", "react against a missing target fails");
			assert.match(String(exit._tag === "Failure" ? exit.cause : ""), /ReactionTargetNotFound/);
		}).pipe(Effect.provide(reactionLayer(scriptedAccess([undefined])))),
	);
});

describe("Reaction.react — react / change / no-op / retract (mocked Drizzle seam)", () => {
	it.effect(
		"a first react on a fresh target writes one upsert statement — ungated, no karma",
		() => {
			// reads: assertTargetLive → live meta; probe → no existing reaction (null).
			// Any user reaches the write: the layer has NO tier gate, and the single-statement
			// batch has NO karma statement (there is no KarmaBump to produce one).
			const {access, batches} = recordingAccess([liveMeta, null]);
			return Effect.gen(function* () {
				const reaction = yield* Reaction;
				const result = yield* reaction.react({
					userId: "caylak-newcomer",
					targetKind: "definition",
					targetId: "def-1",
					emoji: "❤️",
				});
				assert.isTrue(result.changed, "a fresh react is a real state change");
				assert.strictEqual(result.myReaction, "❤️");
				assert.strictEqual(batches.length, 1, "react is one atomic batch (ADR 0014)");
				assert.strictEqual(
					batches[0]?.length,
					1,
					"exactly one statement (the user_reaction upsert) — no score/karma statement",
				);
			}).pipe(Effect.provide(reactionLayer(access)));
		},
	);

	it.effect("changing an existing reaction replaces the emoji (still one upsert, one row)", () => {
		// probe → the user already holds 👍; the new emoji ❤️ differs, so it is a real
		// change writing the upsert (onConflictDoUpdate overwrites in place — cardinality one).
		const {access, batches} = recordingAccess([liveMeta, "👍"]);
		return Effect.gen(function* () {
			const reaction = yield* Reaction;
			const result = yield* reaction.react({
				userId: "u1",
				targetKind: "post",
				targetId: "post-1",
				emoji: "❤️",
			});
			assert.isTrue(result.changed, "a different emoji is a real change");
			assert.strictEqual(result.myReaction, "❤️", "the new emoji replaces the prior one");
			assert.strictEqual(batches[0]?.length, 1, "the change is one upsert statement");
		}).pipe(Effect.provide(reactionLayer(access)));
	});

	it.effect("re-reacting the SAME emoji is an idempotent no-op — no batch", () => {
		// probe → the user already holds 👍 and reacts 👍 again: state matches intent,
		// so no write. The throwing `batch` in scriptedAccess proves the no-op path.
		const access = scriptedAccess([liveMeta, "👍"]);
		return Effect.gen(function* () {
			const reaction = yield* Reaction;
			const result = yield* reaction.react({
				userId: "u1",
				targetKind: "comment",
				targetId: "c-1",
				emoji: "👍",
			});
			assert.isFalse(result.changed, "same emoji is a no-op");
			assert.strictEqual(result.myReaction, "👍", "returns the unchanged reaction");
		}).pipe(Effect.provide(reactionLayer(access)));
	});

	it.effect("retract (emoji: null) on an existing reaction removes the row — one delete", () => {
		// probe → the user holds 😂; retract intent (null) differs, so it is a real change
		// writing the single delete statement.
		const {access, batches} = recordingAccess([liveMeta, "😂"]);
		return Effect.gen(function* () {
			const reaction = yield* Reaction;
			const result = yield* reaction.react({
				userId: "u1",
				targetKind: "definition",
				targetId: "def-1",
				emoji: null,
			});
			assert.isTrue(result.changed, "retract of an existing reaction is a real change");
			assert.strictEqual(result.myReaction, null, "no reaction after retract");
			assert.strictEqual(batches[0]?.length, 1, "retract is one delete statement");
		}).pipe(Effect.provide(reactionLayer(access)));
	});

	it.effect("retract when NONE held is an idempotent no-op — no batch", () => {
		// probe → no existing reaction (null); retract intent (null) matches, so no write.
		const access = scriptedAccess([liveMeta, null]);
		return Effect.gen(function* () {
			const reaction = yield* Reaction;
			const result = yield* reaction.react({
				userId: "u1",
				targetKind: "post",
				targetId: "post-1",
				emoji: null,
			});
			assert.isFalse(result.changed, "retract of nothing is a no-op");
			assert.strictEqual(result.myReaction, null);
		}).pipe(Effect.provide(reactionLayer(access)));
	});

	it.effect("a sandboxed target is reactable — reactions are ungated (no sandbox gate)", () => {
		// The descriptor returns a still-sandboxed meta; Vote would REJECT it, but Reaction
		// reads no sandbox flag and reaches the write. This is the deliberate divergence.
		const {access, batches} = recordingAccess([sandboxedMeta, null]);
		return Effect.gen(function* () {
			const reaction = yield* Reaction;
			const result = yield* reaction.react({
				userId: "caylak-newcomer",
				targetKind: "definition",
				targetId: "def-sandboxed",
				emoji: "🔥",
			});
			assert.isTrue(result.changed, "the reaction on a sandboxed target still writes");
			assert.strictEqual(batches[0]?.length, 1);
		}).pipe(Effect.provide(reactionLayer(access)));
	});
});

describe("Reaction.react — product-usage telemetry (ADR 0153, #2069)", () => {
	it.effect(
		"a committed react emits one {feature, action: react, surface, emoji, userId} event",
		() => {
			// probe → no existing reaction; a fresh react commits, then emits. `surface` is
			// the target kind (`post`), `emoji` rides the trailing blob slot, `userId` is
			// the reacting user (approximate blob).
			const {access} = recordingAccess([liveMeta, null]);
			const events: TelemetryEvent[] = [];
			return Effect.gen(function* () {
				const reaction = yield* Reaction;
				yield* reaction.react({userId: "u1", targetKind: "post", targetId: "post-1", emoji: "❤️"});
				assert.strictEqual(events.length, 1, "exactly one event on a committed react");
				assert.deepStrictEqual(events[0], {
					feature: "reaction",
					action: "react",
					surface: "post",
					userId: "u1",
					emoji: "❤️",
				});
			}).pipe(Effect.provide(reactionLayer(access, recordingTelemetry(events))));
		},
	);

	it.effect("a change (different emoji) emits action: react with the NEW emoji", () => {
		// probe → the user holds 👍; ❤️ differs → a real change. Set/change both map to
		// `action: react` (only the null-emoji toggle-off is `retract`).
		const {access} = recordingAccess([liveMeta, "👍"]);
		const events: TelemetryEvent[] = [];
		return Effect.gen(function* () {
			const reaction = yield* Reaction;
			yield* reaction.react({userId: "u1", targetKind: "definition", targetId: "d-1", emoji: "❤️"});
			assert.deepStrictEqual(events, [
				{feature: "reaction", action: "react", surface: "definition", userId: "u1", emoji: "❤️"},
			]);
		}).pipe(Effect.provide(reactionLayer(access, recordingTelemetry(events))));
	});

	it.effect("a retract (emoji: null) emits action: retract with NO emoji", () => {
		// probe → the user holds 😂; retract (null) differs → a real change removing the row.
		// `action` is `retract` and the event carries no `emoji` (there is no emoji to record).
		const {access} = recordingAccess([liveMeta, "😂"]);
		const events: TelemetryEvent[] = [];
		return Effect.gen(function* () {
			const reaction = yield* Reaction;
			yield* reaction.react({userId: "u1", targetKind: "comment", targetId: "c-1", emoji: null});
			assert.deepStrictEqual(events, [
				{feature: "reaction", action: "retract", surface: "comment", userId: "u1"},
			]);
		}).pipe(Effect.provide(reactionLayer(access, recordingTelemetry(events))));
	});

	it.effect("a no-op re-react (changed: false) emits NOTHING", () => {
		// probe → the user already holds 👍 and reacts 👍 again: the state matches intent,
		// so `react` returns early with `changed: false` BEFORE the emit — no event.
		const events: TelemetryEvent[] = [];
		return Effect.gen(function* () {
			const reaction = yield* Reaction;
			const result = yield* reaction.react({
				userId: "u1",
				targetKind: "post",
				targetId: "post-1",
				emoji: "👍",
			});
			assert.isFalse(result.changed, "same-emoji re-react is a no-op");
			assert.strictEqual(events.length, 0, "a no-op re-react emits nothing (ADR 0153 default)");
		}).pipe(
			Effect.provide(reactionLayer(scriptedAccess([liveMeta, "👍"]), recordingTelemetry(events))),
		);
	});

	it.effect("a no-op retract-when-none-held emits NOTHING", () => {
		// probe → no existing reaction; retract (null) matches → early `changed: false`, no emit.
		const events: TelemetryEvent[] = [];
		return Effect.gen(function* () {
			const reaction = yield* Reaction;
			const result = yield* reaction.react({
				userId: "u1",
				targetKind: "definition",
				targetId: "d-1",
				emoji: null,
			});
			assert.isFalse(result.changed, "retract of nothing is a no-op");
			assert.strictEqual(events.length, 0, "a no-op retract emits nothing");
		}).pipe(
			Effect.provide(reactionLayer(scriptedAccess([liveMeta, null]), recordingTelemetry(events))),
		);
	});

	it.effect("a failed target-liveness check emits nothing (no react, no event)", () => {
		// loadMeta → undefined → ReactionTargetNotFound before probe/write, so the emit
		// (which sits after the committed write) is never reached.
		const events: TelemetryEvent[] = [];
		return Effect.gen(function* () {
			const reaction = yield* Reaction;
			const exit = yield* Effect.exit(
				reaction.react({userId: "u1", targetKind: "post", targetId: "ghost", emoji: "👍"}),
			);
			assert.isTrue(exit._tag === "Failure", "a missing target fails the react");
			assert.strictEqual(events.length, 0, "a failed reaction emits nothing");
		}).pipe(Effect.provide(reactionLayer(scriptedAccess([undefined]), recordingTelemetry(events))));
	});

	it.effect("the emit is off the commit path — the write commits before the emit runs", () => {
		// The `Telemetry` double's `emit` DIES. The write is sequenced BEFORE the emit, so
		// its statement is already recorded in `batches` (the reaction committed) even as the
		// emit blows up — proving the emit is downstream of the commit, never a gate on it.
		// (The production fail-safe that also swallows the failure lives in `TelemetryLive`
		// and is pinned in `Telemetry.unit.test.ts`; here the double lets us see the ordering.)
		const {access, batches} = recordingAccess([liveMeta, null]);
		return Effect.gen(function* () {
			const reaction = yield* Reaction;
			yield* Effect.exit(
				reaction.react({userId: "u1", targetKind: "post", targetId: "post-1", emoji: "🔥"}),
			);
			assert.strictEqual(batches.length, 1, "the reaction write committed before the emit");
			assert.strictEqual(batches[0]?.length, 1, "exactly the one upsert statement");
		}).pipe(Effect.provide(reactionLayer(access, dyingTelemetry)));
	});
});

describe("Reaction.readMine — presence read (mocked Drizzle seam)", () => {
	it.effect("empty ids → empty Map without touching the DB", () =>
		Effect.gen(function* () {
			const reaction = yield* Reaction;
			const mine = yield* reaction.readMine("u1", "definition", []);
			assert.strictEqual(mine.size, 0);
		}).pipe(Effect.provide(reactionLayer(throwingAccess))),
	);

	it.effect("null viewer → empty Map without touching the DB", () =>
		Effect.gen(function* () {
			const reaction = yield* Reaction;
			const mine = yield* reaction.readMine(null, "definition", ["def-1"]);
			assert.strictEqual(mine.size, 0);
		}).pipe(Effect.provide(reactionLayer(throwingAccess))),
	);

	it.effect("returns each target's current emoji keyed by target id", () => {
		// `run` replays the selected rows; readMine folds them into a Map<targetId, emoji>.
		const rows = [
			{targetId: "def-1", emoji: "👍"},
			{targetId: "def-2", emoji: "❤️"},
		];
		const access = scriptedAccess([rows]);
		return Effect.gen(function* () {
			const reaction = yield* Reaction;
			const mine = yield* reaction.readMine("u1", "definition", ["def-1", "def-2", "def-3"]);
			assert.strictEqual(mine.size, 2, "only targets with a reaction are present");
			assert.strictEqual(mine.get("def-1"), "👍");
			assert.strictEqual(mine.get("def-2"), "❤️");
			assert.isUndefined(mine.get("def-3"), "a target with no reaction is absent");
		}).pipe(Effect.provide(reactionLayer(access)));
	});
});

describe("Reaction.readAggregate — per-emoji counts + viewer's own (mocked Drizzle seam)", () => {
	it.effect("empty ids → empty Map without touching the DB", () =>
		Effect.gen(function* () {
			const reaction = yield* Reaction;
			const agg = yield* reaction.readAggregate("u1", "post", []);
			assert.strictEqual(agg.size, 0);
		}).pipe(Effect.provide(reactionLayer(throwingAccess))),
	);

	it.effect(
		"no reactions on the page → every target absent (empty aggregate for the caller)",
		() => {
			// `run` replays: GROUP BY rows (none), then readMine rows (none) for the
			// signed-in viewer. A target with no reactions and no viewer reaction is
			// ABSENT from the map — the caller fills the empty aggregate.
			const access = scriptedAccess([[], []]);
			return Effect.gen(function* () {
				const reaction = yield* Reaction;
				const agg = yield* reaction.readAggregate("u1", "post", ["p1", "p2"]);
				assert.strictEqual(agg.size, 0, "no target appears when the page has no reactions");
			}).pipe(Effect.provide(reactionLayer(access)));
		},
	);

	it.effect("a single-emoji target → one count, the viewer's own surfaced", () => {
		const groupBy = [{targetId: "p1", emoji: "👍", count: 3}];
		const mine = [{targetId: "p1", emoji: "👍"}];
		const access = scriptedAccess([groupBy, mine]);
		return Effect.gen(function* () {
			const reaction = yield* Reaction;
			const agg = yield* reaction.readAggregate("u1", "post", ["p1"]);
			const p1 = agg.get("p1");
			assert.deepStrictEqual(p1?.counts, [{emoji: "👍", count: 3}]);
			assert.strictEqual(p1?.myReaction, "👍", "the viewer's own reaction is surfaced");
		}).pipe(Effect.provide(reactionLayer(access)));
	});

	it.effect("a multi-emoji target → counts ORDERED by the REACTION_EMOJI palette", () => {
		// The GROUP BY rows arrive in a NON-palette order; the aggregate must re-order
		// them to the curated `REACTION_EMOJI` sequence (👍 ❤️ 😂 🤔 😢 🔥). The
		// anonymous viewer's readMine short-circuits with NO read, so only the GROUP BY
		// run is scripted here.
		const groupBy = [
			{targetId: "p1", emoji: "🔥", count: 1},
			{targetId: "p1", emoji: "👍", count: 5},
			{targetId: "p1", emoji: "😂", count: 2},
		];
		const access = scriptedAccess([groupBy]);
		return Effect.gen(function* () {
			const reaction = yield* Reaction;
			const agg = yield* reaction.readAggregate(null, "post", ["p1"]);
			const p1 = agg.get("p1");
			assert.deepStrictEqual(
				p1?.counts.map((c) => c.emoji),
				["👍", "😂", "🔥"],
				"counts are ordered by REACTION_EMOJI, not GROUP BY row order",
			);
			assert.deepStrictEqual(p1?.counts, [
				{emoji: "👍", count: 5},
				{emoji: "😂", count: 2},
				{emoji: "🔥", count: 1},
			]);
			assert.strictEqual(p1?.myReaction, null, "anonymous viewer has no own reaction");
		}).pipe(Effect.provide(reactionLayer(access)));
	});

	it.effect("counts and viewer's-own fold independently across a batch of targets", () => {
		const groupBy = [
			{targetId: "p1", emoji: "👍", count: 2},
			{targetId: "p1", emoji: "❤️", count: 1},
			{targetId: "p2", emoji: "🔥", count: 4},
		];
		// The viewer reacted on p2 (not p1) and on p3 (which has no other reactions).
		const mine = [
			{targetId: "p2", emoji: "🔥"},
			{targetId: "p3", emoji: "😢"},
		];
		const access = scriptedAccess([groupBy, mine]);
		return Effect.gen(function* () {
			const reaction = yield* Reaction;
			const agg = yield* reaction.readAggregate("u1", "post", ["p1", "p2", "p3"]);

			assert.deepStrictEqual(agg.get("p1"), {
				counts: [
					{emoji: "👍", count: 2},
					{emoji: "❤️", count: 1},
				],
				myReaction: null,
			});
			assert.deepStrictEqual(agg.get("p2"), {
				counts: [{emoji: "🔥", count: 4}],
				myReaction: "🔥",
			});
			// p3 has the viewer's reaction but no aggregated counts — it still appears,
			// with an empty `counts` and the viewer's emoji.
			assert.deepStrictEqual(agg.get("p3"), {counts: [], myReaction: "😢"});
		}).pipe(Effect.provide(reactionLayer(access)));
	});
});

describe("Reaction.clearTarget — cleanup batch shape (ADR 0096 §3, mocked Drizzle seam)", () => {
	// A recording batch seam whose db proxy makes every chained call return a marker,
	// so we can count the produced statements without a real engine.
	function recordingBatchAccess(): {access: DrizzleAccess; batches: ReadonlyArray<unknown>[]} {
		const batches: ReadonlyArray<unknown>[] = [];
		const chainable: Record<string, (...a: unknown[]) => unknown> = {};
		const dbProxy: unknown = new Proxy(chainable, {get: () => () => dbProxy});
		const access: DrizzleAccess = {
			run: () => Effect.die(new Error("clearTarget must not call run")),
			batch: <T extends Readonly<[unknown, ...unknown[]]>>(fn: (db: never) => T) => {
				batches.push(fn(dbProxy as never) as ReadonlyArray<unknown>);
				return Effect.succeed([] as never);
			},
		};
		return {access, batches};
	}

	for (const kind of TARGET_KINDS) {
		it.effect(`${kind}: one batch of exactly one statement (the user_reaction wipe)`, () => {
			const {access, batches} = recordingBatchAccess();
			return Effect.gen(function* () {
				const reaction = yield* Reaction;
				yield* reaction.clearTarget(kind, "target-1");
				assert.strictEqual(batches.length, 1, "clearTarget is one atomic batch");
				assert.strictEqual(
					batches[0]?.length,
					1,
					"user_reaction wipe only — no score/karma statement",
				);
			}).pipe(Effect.provide(reactionLayer(access)));
		});
	}
});

describe("ReactionEmojiSchema — non-palette rejection (the wire decode boundary)", () => {
	it("every palette member decodes to itself", () => {
		for (const emoji of REACTION_EMOJI) {
			const decoded = Schema.decodeUnknownSync(ReactionEmojiSchema)(emoji);
			assert.strictEqual(decoded, emoji);
		}
	});

	it("a non-palette emoji fails to decode — an arbitrary emoji is unrepresentable", () => {
		assert.throws(() => Schema.decodeUnknownSync(ReactionEmojiSchema)("🍕"));
		assert.throws(() => Schema.decodeUnknownSync(ReactionEmojiSchema)("not-an-emoji"));
	});
});
