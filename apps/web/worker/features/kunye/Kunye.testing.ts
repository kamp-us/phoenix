/**
 * `makeKunyeStub` — the shared {@link Kunye} test double, mirroring
 * `Pasaport.testing.ts`. Every standing read fails-on-contact (`Effect.die`) by
 * default; a test overrides only the read(s) under test. The one place the
 * `Kunye` shape lives for tests — the capability instances (#1235) that gate on
 * standing stub it here, not by hand.
 */
import {Effect, Layer} from "effect";
import {Kunye} from "./Kunye.ts";

type KunyeShape = typeof Kunye.Service;

const die =
	(method: string) =>
	(..._args: ReadonlyArray<unknown>): Effect.Effect<never, never, never> =>
		Effect.die(new Error(`Kunye.${method} touched an unexpected method`));

const failOnContact: KunyeShape = {
	tierOf: die("tierOf"),
	karmaOf: die("karmaOf"),
	rootOf: die("rootOf"),
};

export const makeKunyeStub = (overrides: Partial<KunyeShape> = {}): Layer.Layer<Kunye> =>
	Layer.succeed(Kunye, {...failOnContact, ...overrides});
