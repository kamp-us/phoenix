/**
 * `@kampus/orphan-sweep` — the orphan integration-stage sweep (part of issue #690). A
 * pure, unit-tested core (`orphan-sweep.ts`) that turns the live set of Cloudflare
 * resources + a protection set (prod, named-dev, open PRs) into a deletion plan that can
 * never touch a protected resource, plus a thin `effect/unstable/cli` bin (`bin.ts`,
 * DRY-RUN by default) that lists CF resources + open PRs behind injectable `Cloudflare`
 * / `Github` services and, with `--execute`, deletes the planned set.
 *
 * Bounds the unbounded leak the #689 run-unique stage names surfaced (#690): a partial
 * integration deploy's orphan `it-*` worker/D1 now accumulates on the shared CF account
 * with no upper bound; this sweep is that bound.
 */
export {Cloudflare, CloudflareLive} from "./cloudflare.ts";
export {Github, GithubLive} from "./github.ts";
export {
	type CfResource,
	computeSweepPlan,
	type DeleteReason,
	type KeepReason,
	type PlannedDelete,
	type PlannedKeep,
	type Protection,
	type SweepPlan,
} from "./orphan-sweep.ts";
export {renderPlan, renderSummary} from "./report.ts";
