/**
 * The çaylak write gate (ADR 0434) driven through the REAL capability seam (ADR 0107). The
 * standing reads are scripted per test and count their calls, so a test also proves which read
 * the gate took. No DB.
 */
import {assert, describe, it} from "@effect/vitest";
import {type Actor, AgentAuthority, CurrentActor, human, unauthenticated} from "@kampus/authz";
import {CurrentUser} from "@kampus/fate-effect";
import {Cause, Effect, Exit, Layer, Option} from "effect";
import * as ConfigProvider from "effect/ConfigProvider";
import {Flags} from "../flagship/Flags.ts";
import {RequestFlagOverrides} from "../flagship/FlagsContext.ts";
import type {EmailUnverified} from "./errors.ts";
import {Kunye} from "./Kunye.ts";
import type {Tier} from "./standing.ts";
import {gateWriteOnVerifiedEmail, requireVerifiedWriter} from "./verified-writer.ts";

interface Standing {
	readonly tier: Tier;
	readonly verified: boolean;
}

const kunyeWith = (standing: Standing, reads: {verified: number}): Layer.Layer<Kunye> =>
	Layer.succeed(Kunye, {
		tierOf: () => Effect.succeed(standing.tier),
		emailVerifiedOf: () =>
			Effect.sync(() => {
				reads.verified += 1;
				return standing.verified;
			}),
		karmaOf: () => Effect.die(new Error("the write gate must not read karma")),
		rootOf: (id: string) => Effect.succeed(id),
	});

const flagsStub = (on: boolean): Layer.Layer<Flags> =>
	Layer.succeed(Flags, {
		getBoolean: () => Effect.succeed(on),
		getString: () => Effect.die("getString not exercised"),
		getNumber: () => Effect.die("getNumber not exercised"),
		getObject: () => Effect.die("getObject not exercised"),
	} as typeof Flags.Service);

type Gate = <A, E, R>(
	body: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | EmailUnverified, unknown>;

const run = (
	gate: Gate,
	opts: {actor: Actor; standing: Standing; flagOn: boolean},
): {exit: Exit.Exit<"ok", EmailUnverified>; verifiedReads: number} => {
	const reads = {verified: 0};
	const exit = Effect.runSyncExit(
		(gate(Effect.succeed("ok" as const)) as Effect.Effect<"ok", EmailUnverified, unknown>).pipe(
			Effect.provide(
				Layer.mergeAll(
					Layer.succeed(CurrentActor, {actor: opts.actor}),
					Layer.succeed(AgentAuthority, {admits: () => Effect.succeed(true)}),
					kunyeWith(opts.standing, reads),
					flagsStub(opts.flagOn),
					Layer.succeed(RequestFlagOverrides, {cookieHeader: null, overridesAllowed: false}),
					// The flag read resolves its eval context off these two, as in `privilege.unit.test.ts`.
					Layer.succeed(CurrentUser, {user: {id: "u", email: "u@kamp.us", name: "u"}}),
					Layer.succeed(
						ConfigProvider.ConfigProvider,
						ConfigProvider.fromUnknown({ENVIRONMENT: "production"}),
					),
				),
			),
		) as Effect.Effect<"ok", EmailUnverified, never>,
	);
	return {exit, verifiedReads: reads.verified};
};

const denial = (exit: Exit.Exit<"ok", EmailUnverified>): EmailUnverified | null => {
	if (!Exit.isFailure(exit)) return null;
	const found = Cause.findErrorOption(exit.cause);
	return Option.isSome(found) ? found.value : null;
};

describe("requireVerifiedWriter — the çaylak write gate, always enforced", () => {
	it("an unverified çaylak is denied EMAIL_UNVERIFIED with a Turkish reason to verify", () => {
		const {exit, verifiedReads} = run(requireVerifiedWriter, {
			actor: human("u"),
			standing: {tier: "çaylak", verified: false},
			flagOn: false,
		});
		const d = denial(exit);
		assert.strictEqual(d?._tag, "kunye/EmailUnverified");
		assert.match(d?.message ?? "", /e-posta adresini doğrula/);
		assert.strictEqual(verifiedReads, 1);
	});

	it("a verified çaylak passes and the body runs", () => {
		const {exit} = run(requireVerifiedWriter, {
			actor: human("u"),
			standing: {tier: "çaylak", verified: true},
			flagOn: false,
		});
		assert.isTrue(Exit.isSuccess(exit));
	});

	it("an unverified yazar passes without the verification read — the gate binds çaylak only", () => {
		const {exit, verifiedReads} = run(requireVerifiedWriter, {
			actor: human("u"),
			standing: {tier: "yazar", verified: false},
			flagOn: false,
		});
		assert.isTrue(Exit.isSuccess(exit));
		assert.strictEqual(verifiedReads, 0);
	});

	it("an account with no row (visitor tier) is denied", () => {
		const {exit} = run(requireVerifiedWriter, {
			actor: human("ghost"),
			standing: {tier: "visitor", verified: true},
			flagOn: false,
		});
		assert.strictEqual(denial(exit)?._tag, "kunye/EmailUnverified");
	});

	it("the anonymous actor is denied fail-closed", () => {
		const {exit} = run(requireVerifiedWriter, {
			actor: unauthenticated,
			standing: {tier: "yazar", verified: true},
			flagOn: false,
		});
		assert.isNotNull(denial(exit));
	});
});

describe("gateWriteOnVerifiedEmail — the dark-ship wrapper (flag decides enforcement)", () => {
	it("flag ON + unverified çaylak ⇒ denied", () => {
		const {exit} = run(gateWriteOnVerifiedEmail, {
			actor: human("u"),
			standing: {tier: "çaylak", verified: false},
			flagOn: true,
		});
		assert.strictEqual(denial(exit)?._tag, "kunye/EmailUnverified");
	});

	it("flag ON + verified çaylak ⇒ the body runs", () => {
		const {exit} = run(gateWriteOnVerifiedEmail, {
			actor: human("u"),
			standing: {tier: "çaylak", verified: true},
			flagOn: true,
		});
		assert.isTrue(Exit.isSuccess(exit));
	});

	it("flag OFF + unverified çaylak ⇒ inert: the body runs and nothing is read", () => {
		const {exit, verifiedReads} = run(gateWriteOnVerifiedEmail, {
			actor: human("u"),
			standing: {tier: "çaylak", verified: false},
			flagOn: false,
		});
		assert.isTrue(Exit.isSuccess(exit));
		assert.strictEqual(verifiedReads, 0);
	});
});
