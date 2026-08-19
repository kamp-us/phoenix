/**
 * `@kampus/orphan-sweep` — the orphan integration-stage sweep. `bin.ts` is DRY-RUN by default
 * and only deletes under `--execute`; the plan can never touch a protected resource.
 *
 * Bounds the leak the #689 run-unique stage names surfaced (#690): a partial integration
 * deploy's orphan `it-*` worker/D1 accumulates on the shared CF account with no upper bound.
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
