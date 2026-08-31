/**
 * The shared {@link VouchLedger} double. Fail-on-contact by default, not a noop: an
 * un-overridden method that gets reached dies, proving the path touched only what it
 * was scripted with (`.patterns/effect-testing.md`).
 */
import {Effect, Layer} from "effect";
import {VouchLedger} from "./VouchLedger.ts";

type VouchLedgerShape = typeof VouchLedger.Service;

const die =
	(method: string) =>
	(..._args: ReadonlyArray<unknown>): Effect.Effect<never, never, never> =>
		Effect.die(new Error(`VouchLedger.${method} touched an unexpected method`));

const failOnContact: VouchLedgerShape = {
	castVouch: die("castVouch"),
	has: die("has"),
	candidatesVouchedBy: die("candidatesVouchedBy"),
	activeCountFor: die("activeCountFor"),
	hasActiveFor: die("hasActiveFor"),
	withdraw: die("withdraw"),
};

export const makeVouchLedgerStub = (
	overrides: Partial<VouchLedgerShape> = {},
): Layer.Layer<VouchLedger> => Layer.succeed(VouchLedger, {...failOnContact, ...overrides});
