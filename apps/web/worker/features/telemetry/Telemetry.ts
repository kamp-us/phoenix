/**
 * `Telemetry` — the single product-usage telemetry seam (ADR 0153, epic #2065). It
 * owns the positional Analytics Engine event schema internally, so no feature ever
 * constructs a raw AE data point or names Analytics Engine.
 *
 * The AE write client is resolved ONCE per isolate in worker init (the `Database`
 * binding-as-service idiom, ADR 0028) and carried on {@link TelemetryClient}, which
 * keeps the binding graph out of the fate runtime's R, where it would never resolve.
 */

import {RuntimeContext} from "alchemy";
import type * as Cloudflare from "alchemy/Cloudflare";
import {Context, Effect, Layer} from "effect";
import {type TelemetryEvent, toDataPoint} from "./schema.ts";

// Resolved in worker init, not in `TelemetryLive` — that is what keeps the fate
// runtime's R free of `WorkerEnvironment`/`Worker` (ADR 0040).
export class TelemetryClient extends Context.Service<
	TelemetryClient,
	Cloudflare.AnalyticsEngine.DatasetClient
>()("@kampus/worker/TelemetryClient") {}

export class Telemetry extends Context.Service<
	Telemetry,
	{
		// Fire-and-forget: both channels are discharged in the layer, so a telemetry
		// failure can never fail the caller (ADR 0153).
		readonly emit: (event: TelemetryEvent) => Effect.Effect<void>;
	}
>()("@kampus/worker/Telemetry") {}

// No finalizer: a Cloudflare binding is not a worker-owned resource.
export const TelemetryLive = Layer.effect(
	Telemetry,
	Effect.gen(function* () {
		const client = yield* TelemetryClient;
		const runtimeContext = yield* RuntimeContext;
		return Telemetry.of({
			emit: (event) =>
				client.writeDataPoint(toDataPoint(event)).pipe(
					Effect.provideService(RuntimeContext, runtimeContext),
					// `ignoreCause`, NOT `ignore`: it discards defects and interruptions too,
					// so a defect thrown inside emit is contained AT THE SEAM and telemetry
					// can never fail the mutation it observes. That makes the fail-safe a
					// property of the seam, so instruments emit BARE (ADR 0153 S4, #2085).
					Effect.ignoreCause({log: "Warn"}),
				),
		});
	}),
);
