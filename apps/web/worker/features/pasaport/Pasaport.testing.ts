/**
 * `makePasaportStub` — the shared `Pasaport` test double. Defaults every one of
 * the 8 `Pasaport` methods to fail-on-contact (`Effect.die`) and takes a partial
 * override of the method(s) under test, returning the `Layer.succeed(Pasaport, …)`
 * layer. One place the interface shape lives — adding a method to `Pasaport` is a
 * single edit here, not shotgun surgery across every hand-rolled stub.
 *
 * A `layerStub` (fail-on-contact), not a `layerNoop` (silently-succeed): an
 * un-overridden method, if reached, dies and fails the test — the discipline that
 * proves the path under test touched only the method(s) it was scripted with.
 *
 * A **factory, not a shared instance** (`.patterns/effect-testing.md`).
 */
import {Effect, Layer} from "effect";
import {Pasaport} from "./Pasaport.ts";

type PasaportShape = typeof Pasaport.Service;

const die =
	(method: string) =>
	(..._args: ReadonlyArray<unknown>): Effect.Effect<never, never, never> =>
		Effect.die(new Error(`Pasaport.${method} touched an unexpected method`));

const failOnContact: PasaportShape = {
	validateSession: die("validateSession"),
	getUserById: die("getUserById"),
	getUsersByIds: die("getUsersByIds"),
	setUsername: die("setUsername"),
	lookupProfile: die("lookupProfile"),
	lookupProfileById: die("lookupProfileById"),
	listContributions: die("listContributions"),
	anonymizeAccount: die("anonymizeAccount"),
};

export const makePasaportStub = (overrides: Partial<PasaportShape> = {}): Layer.Layer<Pasaport> =>
	Layer.succeed(Pasaport, {...failOnContact, ...overrides});
