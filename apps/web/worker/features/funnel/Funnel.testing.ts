/**
 * `makeFunnelStub` — the shared {@link Funnel} test double. Fail-on-contact, not a noop:
 * an un-overridden read that gets reached dies and fails the test. A factory, not a
 * shared instance (`.patterns/effect-testing.md`).
 */
import {Effect, Layer} from "effect";
import {Funnel} from "./Funnel.ts";

type FunnelShape = typeof Funnel.Service;

const die =
	(method: string) =>
	(..._args: ReadonlyArray<unknown>): Effect.Effect<never, never, never> =>
		Effect.die(new Error(`Funnel.${method} touched an unexpected method`));

const failOnContact: FunnelShape = {
	tierPopulation: die("tierPopulation"),
	firstContribution: die("firstContribution"),
	vouchRate: die("vouchRate"),
	timeToPromotion: die("timeToPromotion"),
	rollupWeeklyCohorts: die("rollupWeeklyCohorts"),
};

export const makeFunnelStub = (overrides: Partial<FunnelShape> = {}): Layer.Layer<Funnel> =>
	Layer.succeed(Funnel, {...failOnContact, ...overrides});
