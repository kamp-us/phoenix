/**
 * `makeVouchLedgerStub` — the shared {@link VouchLedger} test double. Defaults every
 * method to fail-on-contact (`Effect.die`) and takes a partial override of the
 * method(s) under test (`.patterns/effect-testing.md`, the `makePasaportStub` idiom).
 * A `layerStub`, not a `layerNoop`: an un-overridden method, if reached, dies and
 * fails the test — proving the path touched only the method(s) it was scripted with.
 */
import {Effect, Layer} from "effect";
import {VouchLedger} from "./VouchLedger.ts";

type VouchLedgerShape = typeof VouchLedger.Service;

const die =
	(method: string) =>
	(..._args: ReadonlyArray<unknown>): Effect.Effect<never, never, never> =>
		Effect.die(new Error(`VouchLedger.${method} touched an unexpected method`));

const failOnContact: VouchLedgerShape = {
	record: die("record"),
	has: die("has"),
};

export const makeVouchLedgerStub = (
	overrides: Partial<VouchLedgerShape> = {},
): Layer.Layer<VouchLedger> => Layer.succeed(VouchLedger, {...failOnContact, ...overrides});
