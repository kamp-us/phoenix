/**
 * `Telemetry` service — the single product-usage telemetry seam (ADR 0153, epic
 * #2065). One narrow surface, `emit(event)`, that every instrument calls; the
 * service owns the fixed positional Analytics Engine event-schema internally so
 * no feature ever constructs a raw AE data point or names Analytics Engine.
 *
 * Mirrors the `Flagship`/`Database` binding-as-service idiom (ADR 0028): the AE
 * write client is resolved ONCE per isolate in worker init (where the
 * `WriteDataset` binding is ambient) and carried on the {@link TelemetryClient}
 * seam — the `Database` tag-holds-the-resolved-handle idiom — so `TelemetryLive`'s
 * build-time R is just that client seam plus `RuntimeContext`, never the binding
 * graph (which never resolves at the fate runtime scope). Two channels are
 * discharged inside the layer so call-sites get a clean `Effect<void>`:
 *   - `writeDataPoint`'s ambient `RuntimeContext` requirement — captured once and
 *     `provideService`'d, the same pattern `LiveTopics.publish` uses (`index.ts`).
 *   - the WHOLE failure `Cause` — swallowed with a log (fire-and-forget
 *     best-effort). A telemetry failure — a typed `DatasetError` OR a *defect* —
 *     can NEVER fail the mutation it observes (ADR 0153 fail-safe invariant, S4).
 *     `Effect.ignoreCause` (not `Effect.ignore`) is what makes this a SEAM property:
 *     it discards defects and interruptions too, so `emit: Effect<void>` genuinely
 *     cannot fail OR die and every caller gets S4 by construction — no per-call-site
 *     `ignoreCause` an instrument must remember.
 *
 * The `Context.Service` + `Layer.effect` idiom is grounded in effect-smol
 * `LLMS.md` §"Writing Effect services" → "Context.Service" and
 * `.patterns/effect-context-service.md`.
 */

import {RuntimeContext} from "alchemy";
import type * as Cloudflare from "alchemy/Cloudflare";
import {Context, Effect, Layer} from "effect";
import {type TelemetryEvent, toDataPoint} from "./schema.ts";

/**
 * The init-resolved AE write client seam. Holds the `DatasetClient` resolved once
 * in worker init via `Cloudflare.AnalyticsEngine.WriteDataset(Events)` — where the
 * binding graph is ambient — and provided dependency-free to the fate runtime,
 * exactly as the `Database` tag holds the raw D1 handle (ADR 0040). Keeping the
 * binding resolution in init (not in `TelemetryLive`) is what keeps the fate
 * runtime's R free of `WorkerEnvironment`/`Worker`.
 */
export class TelemetryClient extends Context.Service<
	TelemetryClient,
	Cloudflare.AnalyticsEngine.DatasetClient
>()("@kampus/worker/TelemetryClient") {}

export class Telemetry extends Context.Service<
	Telemetry,
	{
		/**
		 * Record one product-usage event. Fire-and-forget best-effort: no error and
		 * no requirement channel at the call-site (both discharged in the layer), so
		 * a telemetry failure never surfaces to — or fails — the caller (ADR 0153).
		 */
		readonly emit: (event: TelemetryEvent) => Effect.Effect<void>;
	}
>()("@kampus/worker/Telemetry") {}

/**
 * The isolate-level `Telemetry` layer. Resolves the init-provided
 * {@link TelemetryClient} and captures `RuntimeContext` at build; both are
 * discharged inside `emit` so its own error and requirement channels are empty
 * (`Effect<void>`). No finalizer: a Cloudflare binding is not a worker-owned
 * resource.
 */
export const TelemetryLive = Layer.effect(
	Telemetry,
	Effect.gen(function* () {
		const client = yield* TelemetryClient;
		const runtimeContext = yield* RuntimeContext;
		return Telemetry.of({
			emit: (event) =>
				client.writeDataPoint(toDataPoint(event)).pipe(
					Effect.provideService(RuntimeContext, runtimeContext),
					// Swallow-with-log the WHOLE Cause: telemetry is best-effort, never a
					// source of truth, and must not fail the mutation it observes (ADR 0153
					// S4). `ignoreCause` (not `ignore`) discards defects/interruptions too,
					// so a DEFECT thrown inside emit — a sync throw in `writeDataPoint`, an
					// `orDie`, a `toDataPoint` bug — is contained AT THE SEAM. That makes S4
					// a property of the seam for every instrument, so callers emit BARE and
					// never repeat a call-site `ignoreCause` (ADR 0153, #2085).
					Effect.ignoreCause({log: "Warn"}),
				),
		});
	}),
);
