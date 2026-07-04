/**
 * `definition.react` WIRE-boundary coverage (epic #1840, #1865) — the reaction
 * mutation driven through its real external interface (`resolveWire`: input decode +
 * the `encodeWireError` class→wire-code seam), over a stub `Sozluk` + a `Flags`
 * double. Four things are wrong-or-right with no database:
 *
 *   - **flag ON delegates.** The resolver hands `{definitionId, reactorId, emoji}` to
 *     `Sozluk.reactToDefinition` and returns the fresh-aggregate `Definition`.
 *   - **flag OFF is inert (dark ship, ADR 0083).** The react never lands
 *     (`reactToDefinition` fail-on-contact); the resolver re-resolves the unchanged
 *     definition, so a merged-but-unflipped feature is invisible.
 *   - **auth-only gate.** A signed-out reactor gets the invisible `UNAUTHORIZED` —
 *     never reaching the service (no voter-tier gate; that is Vote's alone).
 *   - **palette decode.** A non-`REACTION_EMOJI` emoji fails to decode at the wire
 *     boundary, so an arbitrary emoji is structurally unrepresentable (#1865 AC#1).
 */
import {assert, describe, it} from "@effect/vitest";
import {CurrentUser} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Cause, Effect, Exit, Layer} from "effect";
import {resolveWire} from "../fate/resolve-wire.testing.ts";
import {Flags} from "../flagship/Flags.ts";
import {EMPTY_REACTION_AGGREGATE} from "../reaction/Reaction.ts";
import {mutations} from "./mutations.ts";
import type {DefinitionRow, ReactDefinitionInput} from "./Sozluk.ts";
import {Sozluk} from "./Sozluk.ts";

const REACTOR_USER = {id: "u-reactor", email: "reactor@example.com", name: "reactor"};

const runtimeContextStub: BaseRuntimeContext = {
	Type: "definition-react-test",
	id: "definition-react-test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

const flagsStub = (on: boolean): Layer.Layer<Flags> =>
	Layer.succeed(
		Flags,
		// biome-ignore lint/plugin: a Flags test double — only getBoolean is exercised here.
		{
			getBoolean: () => Effect.succeed(on),
			getString: () => Effect.die(new Error("unused")),
			getNumber: () => Effect.die(new Error("unused")),
			getObject: () => Effect.die(new Error("unused")),
		} as unknown as typeof Flags.Service,
	);

// A `Sozluk` whose named methods are scripted; every OTHER method dies on contact, so
// a passing test proves the resolver reached only the method its path routes to
// (mirrors `definition-mutation.unit.test.ts`'s `sozlukStub`).
const sozlukProxy = (methods: Partial<typeof Sozluk.Service>): Layer.Layer<Sozluk> =>
	Layer.succeed(
		Sozluk,
		new Proxy(methods, {
			get(target, prop) {
				if (prop in target) return (target as Record<string, unknown>)[prop as string];
				return () =>
					Effect.die(new Error(`Sozluk.${String(prop)} not exercised in definition.react`));
			},
		}) as typeof Sozluk.Service,
	);

// A wire-shaped definition row (post-react) the stub returns; `reactions` is the fresh
// aggregate the resolver forwards onto the `Definition`.
const REACTED_ROW: DefinitionRow = {
	id: "def-1",
	body: "bir tanım",
	score: 3,
	author: "yazar",
	authorId: "u-author",
	createdAt: new Date("2026-01-01T00:00:00Z"),
	updatedAt: new Date("2026-01-01T00:00:00Z"),
	myVote: null,
	reactions: {counts: [{emoji: "👍", count: 1}], myReaction: "👍"},
};

// The CURRENT (unreacted) row the inert flag-off path re-resolves: empty aggregate.
const CURRENT_ROW: DefinitionRow = {...REACTED_ROW, reactions: EMPTY_REACTION_AGGREGATE};

const requestCtx = (
	user: {id: string; email: string; name: string} | undefined,
	on: boolean,
	sozluk: Layer.Layer<Sozluk>,
) =>
	Layer.mergeAll(
		sozluk,
		flagsStub(on),
		Layer.succeed(CurrentUser, {user}),
		Layer.succeed(RuntimeContext, runtimeContextStub),
	);

const wireCodeOf = (cause: Cause.Cause<unknown>): unknown => {
	const error = Cause.findErrorOption(cause);
	return error._tag === "Some" ? (error.value as {code?: unknown}).code : undefined;
};

describe("definition.react — dark-ship + delegation", () => {
	it.effect("flag ON: delegates to reactToDefinition and returns the fresh aggregate", () => {
		const calls: ReactDefinitionInput[] = [];
		return Effect.gen(function* () {
			const def = yield* resolveWire(mutations["definition.react"], {
				input: {id: "def-1", emoji: "👍"},
				select: ["id", "reactions"],
			});
			assert.deepStrictEqual(calls, [{definitionId: "def-1", reactorId: "u-reactor", emoji: "👍"}]);
			assert.deepStrictEqual((def as {reactions: unknown}).reactions, {
				counts: [{emoji: "👍", count: 1}],
				myReaction: "👍",
			});
		}).pipe(
			Effect.provide(
				requestCtx(
					REACTOR_USER,
					true,
					sozlukProxy({
						reactToDefinition: (input) => {
							calls.push(input);
							return Effect.succeed(REACTED_ROW);
						},
					}),
				),
			),
		);
	});

	it.effect("flag OFF: inert — no react lands, the unchanged definition is returned", () =>
		Effect.gen(function* () {
			const def = yield* resolveWire(mutations["definition.react"], {
				input: {id: "def-1", emoji: "👍"},
				select: ["id", "reactions"],
			});
			assert.strictEqual((def as {id: string}).id, "def-1");
			// The current, unreacted aggregate — the react write never happened while dark.
			assert.deepStrictEqual((def as {reactions: unknown}).reactions, EMPTY_REACTION_AGGREGATE);
		}).pipe(
			Effect.provide(
				requestCtx(
					REACTOR_USER,
					false,
					// reactToDefinition fail-on-contact: the write must never land when dark.
					sozlukProxy({getDefinitionsByIds: () => Effect.succeed([CURRENT_ROW])}),
				),
			),
		),
	);

	it.effect("a signed-out reactor gets UNAUTHORIZED — never reaches the service", () =>
		Effect.gen(function* () {
			const exit = yield* resolveWire(mutations["definition.react"], {
				input: {id: "def-1", emoji: "👍"},
				select: ["id"],
			}).pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) assert.strictEqual(wireCodeOf(exit.cause), "UNAUTHORIZED");
		}).pipe(Effect.provide(requestCtx(undefined, true, sozlukProxy({})))),
	);

	it.effect("a non-palette emoji fails to decode at the wire boundary — no service call", () =>
		Effect.gen(function* () {
			// Deliberately passing an off-palette emoji past TS to prove the wire decode rejects it.
			const exit = yield* resolveWire(mutations["definition.react"], {
				input: {id: "def-1", emoji: "🎉"},
				select: ["id"],
			} as never).pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
		}).pipe(Effect.provide(requestCtx(REACTOR_USER, true, sozlukProxy({})))),
	);
});
