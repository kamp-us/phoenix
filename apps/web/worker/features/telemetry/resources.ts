/**
 * The Analytics Engine telemetry-IaC surface (ADR 0153), homed beside its service rather
 * than in `db/resources.ts`, mirroring `features/flagship/resources.ts`.
 *
 * An AE dataset is a Worker binding, not an API-provisioned resource: it is created on first
 * `writeDataPoint`, so there is no provisioning or dashboard step.
 */
import * as Cloudflare from "alchemy/Cloudflare";

/** One dataset, partitioned by the positional index + blobs, never per-domain datasets. */
export const Events = Cloudflare.AnalyticsEngine.Dataset("Events", {dataset: "app_events"});
