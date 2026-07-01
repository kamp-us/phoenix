/**
 * `makeFunnelStub` — the shared {@link Funnel} test double, mirroring
 * `Report.testing.ts` / `Kunye.testing.ts`. Every read fails-on-contact
 * (`Effect.die`) by default; a test overrides only the read under test, returning
 * the `Layer.succeed(Funnel, …)` layer. The one place the `Funnel` shape lives for
 * tests — adding a read is a single edit here, not shotgun surgery across stubs.
 *
 * A `layerStub` (fail-on-contact), not a `layerNoop`: an un-overridden read, if
 * reached, dies and fails the test. A **factory, not a shared instance**
 * (`.patterns/effect-testing.md`).
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
};

export const makeFunnelStub = (overrides: Partial<FunnelShape> = {}): Layer.Layer<Funnel> =>
	Layer.succeed(Funnel, {...failOnContact, ...overrides});
