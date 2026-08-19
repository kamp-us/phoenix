/**
 * The shared {@link Kunye} test double. Every standing read fails-on-contact by default,
 * so a test overrides only the read under test and an unexpected read is a failure.
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
