/**
 * The funnel root query resolver (#1589) — `funnel.summary`, the founder/mod
 * conversion readout's single gated read.
 *
 * Two gates, both enforced HERE (the `Funnel` service read is unconditional):
 *
 *   1. The `phoenix-funnel-readout` dark-ship flag (default-off, ADR 0083). Off ⇒
 *      the read fails the invisible {@link Denied}, exactly like a non-mod read — so
 *      with the flag off (default / Flagship outage) nothing leaks, even on a direct
 *      call. Read with the safe `false` default (`stats`/`divan` idiom).
 *   2. The {@link requireFunnelAccess} capability gate — platform-moderation only.
 *      `yield* ViewFunnel` makes the read unreachable without the discharged grant.
 *
 * A synthetic singleton like `stats.landingStats`: the wire type is the NAME string
 * (`"FunnelSummary"`), not the view class, so the entity stays off the source-
 * completeness path (the resolver is its only producer, no by-id fetch). Codegen is
 * unchanged — the client root types off `Root`'s `funnelSummaryDataView` + this
 * handler.
 */
import {Fate} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {PHOENIX_FUNNEL_READOUT} from "../../../src/flags/keys.ts";
import {Flags} from "../flagship/Flags.ts";
import {provideRequestFlags} from "../flagship/FlagsContext.ts";
import {Denied} from "../kunye/errors.ts";
import {Funnel, promotionRate} from "./Funnel.ts";
import {requireFunnelAccess, ViewFunnel} from "./gate.ts";

const FUNNEL_SUMMARY_ID = "summary";

/** Is the funnel readout on for this request? Safe-default `false` (dark). */
const readoutOn = Effect.gen(function* () {
	const flags = yield* Flags;
	return yield* flags.getBoolean(PHOENIX_FUNNEL_READOUT, false).pipe(provideRequestFlags);
});

// The post-gate summary read — `ViewFunnel`-gated in R (`requireFunnelAccess`
// provides the grant). `yield* ViewFunnel` requires the proof; the counts are
// unreachable without a discharged grant.
const summaryGated = Effect.fn("funnel.summaryGated")(function* () {
	yield* ViewFunnel;
	const funnel = yield* Funnel;
	const population = yield* funnel.tierPopulation();
	return {
		__typename: "FunnelSummary" as const,
		id: FUNNEL_SUMMARY_ID,
		caylakCount: population.caylakCount,
		yazarCount: population.yazarCount,
		promotionRate: promotionRate(population),
	};
});

export const queries = {
	"funnel.summary": Fate.query(
		{type: "FunnelSummary", error: Schema.Union([Denied])},
		Effect.fn("funnel.summary")(function* () {
			if (!(yield* readoutOn)) {
				return yield* Effect.fail(new Denied({message: "Dönüşüm metrikleri şu an kapalı."}));
			}
			return yield* requireFunnelAccess(summaryGated());
		}),
	),
};
