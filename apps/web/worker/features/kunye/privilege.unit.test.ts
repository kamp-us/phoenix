/**
 * The karma-VALUE privilege gates (#150) through the REAL capability seams — not a
 * re-implemented `karma >= floor` check. {@link requireCanPost} / {@link requireCanFlag}
 * discharge `CanPost` / `CanFlag` (`Capability.Class`, ADR 0107) over a fresh
 * {@link Kunye.karmaOf} read, threading the minted `Grant` into the gated body's R
 * channel — so a reached body proves the proof was supplied (enforcement-by-R), and a
 * below-floor read fails the visible {@link InsufficientKarma} (`INSUFFICIENT_KARMA`).
 *
 * The flag-aware wrappers ({@link gateContentOnKarma} / {@link gateFlagOnKarma}) are the
 * dark-ship seam: with `phoenix-karma-gates` OFF the karma read never runs and the body
 * passes freely (today's behavior); ON, the floor is enforced. The floors are read off
 * {@link KARMA_FLOORS} so a floor move can't drift from the test.
 *
 * All ports are scripted (`CurrentActor` the actor, `Kunye` the karma, `AgentAuthority`
 * admit-all, `Flags` the gate switch, `CurrentUser` for `provideRequestFlags`) — no DB.
 */
import {assert, describe, it} from "@effect/vitest";
import {type Actor, AgentAuthority, CurrentActor, human, unauthenticated} from "@kampus/authz";
import {CurrentUser, type CurrentUserInfo} from "@kampus/fate-effect";
import {Cause, Effect, Exit, Layer, Option} from "effect";
import * as ConfigProvider from "effect/ConfigProvider";
import {Flags} from "../flagship/Flags.ts";
import {RequestFlagOverrides} from "../flagship/FlagsContext.ts";
import {InsufficientKarma} from "./errors.ts";
import {Kunye} from "./Kunye.ts";
import {
	CanFlag,
	CanPost,
	gateContentOnKarma,
	gateFlagOnKarma,
	KARMA_FLOORS,
	requireCanFlag,
	requireCanPost,
} from "./privilege.ts";

/** A `Kunye` that answers only `karmaOf` (fixed) — every other read fails-on-contact. */
const kunyeWithKarma = (karma: number): Layer.Layer<Kunye> =>
	Layer.succeed(Kunye, {
		karmaOf: () => Effect.succeed(karma),
		tierOf: () => Effect.die(new Error("privilege gate must not read tier — separate axis")),
		rootOf: (id: string) => Effect.succeed(id),
	});

/** A `Flags` whose `getBoolean` returns a fixed value — the gate switch. */
const flagsStub = (on: boolean): Layer.Layer<Flags> =>
	Layer.succeed(Flags, {
		getBoolean: () => Effect.succeed(on),
		getString: () => Effect.succeed(""),
		getNumber: () => Effect.succeed(0),
		getObject: () => Effect.succeed({}),
	} as typeof Flags.Service);

const userInfo = (id: string): CurrentUserInfo => ({id, email: `${id}@kamp.us`, name: id});

/**
 * Run one gate over `body = succeed("ok")` for an actor at a karma value, with the flag
 * on/off. Provides every port the gate touches; `user` feeds `provideRequestFlags`.
 */
const run = (
	gate: <A, E, R>(body: Effect.Effect<A, E, R>) => Effect.Effect<A, E | InsufficientKarma, unknown>,
	opts: {
		actor: Actor;
		karma: number;
		flagOn: boolean;
		user: CurrentUserInfo | undefined;
	},
): Exit.Exit<"ok", InsufficientKarma> =>
	Effect.runSyncExit(
		(gate(Effect.succeed("ok" as const)) as Effect.Effect<"ok", InsufficientKarma, unknown>).pipe(
			Effect.provideService(CurrentActor, {actor: opts.actor}),
			Effect.provideService(AgentAuthority, {admits: () => Effect.succeed(true)}),
			Effect.provide(kunyeWithKarma(opts.karma)),
			Effect.provide(flagsStub(opts.flagOn)),
			Effect.provideService(CurrentUser, {user: opts.user}),
			// `provideRequestFlags` (the flag-aware wrappers) reads the per-request
			// override seam + `AppConfig` for the stage; a non-development stage reads no
			// cookie, so a null-cookie override + a bare config provider is all the flag
			// path needs to resolve under `runSyncExit`.
			Effect.provideService(RequestFlagOverrides, {cookieHeader: null}),
			Effect.provideService(
				ConfigProvider.ConfigProvider,
				ConfigProvider.fromUnknown({ENVIRONMENT: "production"}),
			),
		) as Effect.Effect<"ok", InsufficientKarma, never>,
	);

/** The failure's `InsufficientKarma`, or `null` if the exit succeeded / died. */
const denial = (exit: Exit.Exit<"ok", InsufficientKarma>): InsufficientKarma | null => {
	if (!Exit.isFailure(exit)) return null;
	const found = Cause.findErrorOption(exit.cause);
	return Option.isSome(found) ? found.value : null;
};

describe("requireCanPost — the ≥ −4 content-creation floor (always enforced)", () => {
	it("a positive-karma actor passes and the body runs", () => {
		const exit = run(requireCanPost, {
			actor: human("u"),
			karma: 10,
			flagOn: true,
			user: userInfo("u"),
		});
		assert.isTrue(Exit.isSuccess(exit));
	});

	it("an actor exactly at the floor (−4) passes — the floor is inclusive", () => {
		const exit = run(requireCanPost, {
			actor: human("u"),
			karma: KARMA_FLOORS.post,
			flagOn: true,
			user: userInfo("u"),
		});
		assert.isTrue(Exit.isSuccess(exit));
	});

	it("an actor below the floor (−5) is denied INSUFFICIENT_KARMA carrying need + have", () => {
		const exit = run(requireCanPost, {
			actor: human("u"),
			karma: -5,
			flagOn: true,
			user: userInfo("u"),
		});
		const d = denial(exit);
		assert.isNotNull(d);
		assert.strictEqual(d?._tag, "kunye/InsufficientKarma");
		assert.strictEqual(d?.need, KARMA_FLOORS.post);
		assert.strictEqual(d?.have, -5);
	});

	it("the anonymous actor is denied (fail-closed) even at high scripted karma", () => {
		const exit = run(requireCanPost, {
			actor: unauthenticated,
			karma: 999,
			flagOn: true,
			user: undefined,
		});
		assert.isNotNull(denial(exit));
	});
});

describe("requireCanFlag — the ≥ 50 report-filing floor (always enforced)", () => {
	it("an actor at the floor (50) passes", () => {
		const exit = run(requireCanFlag, {
			actor: human("u"),
			karma: KARMA_FLOORS.flag,
			flagOn: true,
			user: userInfo("u"),
		});
		assert.isTrue(Exit.isSuccess(exit));
	});

	it("an actor below the floor (49) is denied INSUFFICIENT_KARMA with need = 50", () => {
		const exit = run(requireCanFlag, {
			actor: human("u"),
			karma: 49,
			flagOn: true,
			user: userInfo("u"),
		});
		const d = denial(exit);
		assert.strictEqual(d?.need, KARMA_FLOORS.flag);
		assert.strictEqual(d?.have, 49);
	});
});

describe("gateContentOnKarma — the dark-ship wrapper (flag decides enforcement)", () => {
	it("flag ON + below floor ⇒ denied INSUFFICIENT_KARMA", () => {
		const exit = run(gateContentOnKarma, {
			actor: human("u"),
			karma: -10,
			flagOn: true,
			user: userInfo("u"),
		});
		assert.strictEqual(denial(exit)?._tag, "kunye/InsufficientKarma");
	});

	it("flag OFF + below floor ⇒ inert: the body runs (today's behavior)", () => {
		const exit = run(gateContentOnKarma, {
			actor: human("u"),
			karma: -10,
			flagOn: false,
			user: userInfo("u"),
		});
		assert.isTrue(Exit.isSuccess(exit));
	});
});

describe("gateFlagOnKarma — the dark-ship wrapper over the flag floor", () => {
	it("flag ON + below floor ⇒ denied", () => {
		const exit = run(gateFlagOnKarma, {
			actor: human("u"),
			karma: 0,
			flagOn: true,
			user: userInfo("u"),
		});
		assert.strictEqual(denial(exit)?._tag, "kunye/InsufficientKarma");
	});

	it("flag OFF + below floor ⇒ inert: the body runs", () => {
		const exit = run(gateFlagOnKarma, {
			actor: human("u"),
			karma: 0,
			flagOn: false,
			user: userInfo("u"),
		});
		assert.isTrue(Exit.isSuccess(exit));
	});
});

describe("the InsufficientKarma error surface (#150 / #146)", () => {
	it("CanPost and CanFlag are distinct capability tags", () => {
		assert.notStrictEqual(CanPost.key, CanFlag.key);
	});

	it("carries the FateWireCode INSUFFICIENT_KARMA", () => {
		const e = new InsufficientKarma({message: "x", need: KARMA_FLOORS.post, have: -5});
		assert.strictEqual(e._tag, "kunye/InsufficientKarma");
	});
});
