/**
 * The Analytics Engine telemetry-IaC surface — the `Events` dataset the
 * product-usage telemetry seam writes to (ADR 0153). Homed beside its future
 * service (`Telemetry.ts`, #2067) instead of in `db/resources.ts`, mirroring
 * `features/flagship/resources.ts` (ADR 0081).
 *
 * An AE dataset is a Worker binding, not an API-provisioned resource: it is
 * created on first `writeDataPoint`, so there is no provisioning or dashboard
 * step. The alchemy stack (`alchemy.run.ts`) `bind()`s it onto the worker (its
 * `env` block); the worker init resolves the Effect-native client via
 * `Cloudflare.AnalyticsEngine.WriteDataset(Events)` — the same declare→bind→
 * resolve shape as the Flagship app.
 */
import * as Cloudflare from "alchemy/Cloudflare";

/**
 * The single Analytics Engine dataset — the `app_events` store every product-usage
 * instrument writes to (ADR 0153). One dataset, partitioned by the positional
 * index + blobs the `Telemetry` service (#2067) owns, not per-domain datasets.
 */
export const Events = Cloudflare.AnalyticsEngine.Dataset("Events", {dataset: "app_events"});
