/**
 * `@kampus/orphan-sweep` pure core — turn the live set of Cloudflare resources into a
 * deletion plan that bounds the integration-stage leak (#690) WITHOUT ever touching a
 * protected resource. IO-free and total: every function here is a deterministic
 * transform over already-listed `CfResource[]` + a protection set; the CF/`gh`
 * boundary lives in `cloudflare.ts`/`github.ts`, and this module never deletes
 * anything itself.
 *
 * Why a leak exists: see #690 (carved out of #689). The sweep deletes ephemeral
 * integration (`it-*`) resources, CLOSED-PR preview (`pr-<n>`) resources, and — behind a
 * separate opt-in — stale `test`/`test-*` stage resources (#2340). `dev`/`dev-*`
 * named-dev stages are deny-by-protection and never swept, flag or not.
 *
 * The safety property is the whole point. A sweep that deletes a prod, named-dev, or
 * open-PR resource is catastrophic and irreversible (ADR 0032: these are REAL remote
 * D1s, never emulated). So matching is allow-by-pattern + deny-by-protection, both
 * anchored, and exhaustively unit-tested.
 */

/**
 * A Cloudflare resource as listed at the boundary. The pure core only ever reads the
 * stage-bearing name; the extra `appId`/`appName` coordinates are boundary delete-keys it
 * ignores.
 */
export type CfResource =
	| {readonly kind: "worker"; readonly name: string}
	| {readonly kind: "d1"; readonly name: string}
	/** A Flagship app; `name` is its physical name (carries the stage), `appId` is the delete key (apps delete by server id, not name). */
	| {readonly kind: "flagship-app"; readonly name: string; readonly appId: string}
	/**
	 * A Flagship flag; `name` is its stage-invariant `key`, `appName` is the parent app's
	 * physical name (the stage-bearer the core decodes), `appId` the parent app's server id
	 * (a flag is a sub-resource of an app — its delete path is `apps/{appId}/flags/{key}`).
	 */
	| {
			readonly kind: "flagship-flag";
			readonly name: string;
			readonly appId: string;
			readonly appName: string;
	  };

/**
 * The protection set. The plan is deny-by-default for anything that matches a protected
 * pattern, BEFORE any allow-pattern is consulted.
 *
 * Physical name shape (grounded in `.github/workflows/deploy.yml` "Resolve web preview
 * D1 id" + `apps/web/alchemy.run.ts`): alchemy names a resource
 * `${stack}-${id}-${stage}-${suffix}`, `_`→`-` sanitized. Stack is `phoenix`; the
 * worker id is `phoenix` and the D1 id `phoenix_db`→`phoenix-db`. So for stage
 * `<stage>`: worker = `phoenix-phoenix-<stage>-<suffix>`, D1 =
 * `phoenix-phoenix-db-<stage>-<suffix>`. The integration stage is `it-…`, prod is
 * `prod`, a preview is `pr-<n>`.
 */
export interface Protection {
	/** Stage names (NOT physical names) that must never be swept — e.g. `prod`, named-dev. */
	readonly protectedStages: ReadonlyArray<string>;
	/** Open PR numbers; their `pr-<n>` preview stage is kept until the PR closes. */
	readonly openPrNumbers: ReadonlyArray<number>;
	/**
	 * Sweep preview (`pr-<n>`) resources of CLOSED PRs too, not just `it-*`. Off by
	 * default: #690's mandate is the `it-*` integration leak; preview cleanup already
	 * has its own deploy-time path, and sweeping it is opt-in to keep blast radius
	 * minimal.
	 */
	readonly sweepClosedPreviews: boolean;
	/**
	 * Sweep stale dev/test per-stage resources (#2340). The dev/test family splits into
	 * a *sweepable* and a *protected* half, and this flag governs ONLY the sweepable half:
	 *
	 * - **Sweepable** — ephemeral `test`/`test-*` stages: machine-owned, run-unique per
	 *   spin-up (like `it-*`, but outside #690's `it-*` mandate — hence a separate opt-in).
	 * - **Protected (NEVER swept, flag or not)** — `dev`/`dev-*` named-dev stages
	 *   (`dev-usirin` is exactly this shape). A dev stage belongs to a human, and the pure
	 *   core carries no signal — no age, no live-worker match — to distinguish a dead
	 *   named-dev stage from an active one, so the whole `dev-*` family stays
	 *   deny-by-protection. This is the load-bearing carve-out the #2340 design tension names.
	 *
	 * Off by default, mirroring `sweepClosedPreviews`: it widens the delete set, so it is
	 * opt-in and dry-run-safe.
	 */
	readonly sweepDevTestStages: boolean;
}

export type DeleteReason = "orphan-integration" | "closed-preview" | "stale-dev-test";

export type KeepReason =
	| "protected-stage"
	| "open-pr"
	| "unrecognized"
	| "preview-sweep-disabled"
	| "named-dev"
	| "dev-test-sweep-disabled";

export interface PlannedDelete {
	readonly resource: CfResource;
	readonly reason: DeleteReason;
	readonly stage: string;
}

export interface PlannedKeep {
	readonly resource: CfResource;
	readonly reason: KeepReason;
}

export interface SweepPlan {
	readonly toDelete: ReadonlyArray<PlannedDelete>;
	readonly kept: ReadonlyArray<PlannedKeep>;
}

const STACK = "phoenix";
const WORKER_PREFIX = `${STACK}-${STACK}-`;
const D1_PREFIX = `${STACK}-${STACK}-db-`;
/**
 * The Flagship app physical-name prefix. The app is `Cloudflare.FlagshipApp("phoenix_flags")`
 * (`apps/web/worker/features/flagship/resources.ts`), so alchemy's `createPhysicalName`
 * yields the same `${stack}-${id}-${stage}-${suffix}` shape as workers/D1, `_`→`-`
 * lowercased: id `phoenix_flags` → `phoenix-flags`, giving prefix `phoenix-phoenix-flags-`.
 */
export const FLAGSHIP_APP_NAME_PREFIX = `${STACK}-${STACK}-flags-`;

/**
 * Decode a physical CF name back to its stage (the `<stage>` between the
 * stack/id prefix and the alchemy `-<suffix>`), or `undefined` if the name is not one
 * of OUR resources (a foreign script, a non-phoenix D1). The suffix alchemy appends is
 * a `-`-joined token, so the decoded stage is everything between the prefix and the
 * LAST dash-segment.
 *
 * Returning `undefined` for an unrecognized name is the safety hinge: an unrecognized
 * resource can never enter the delete set (it falls through to a kept `unrecognized`).
 */
const decodeStage = (resource: CfResource): string | undefined => {
	// Each kind names its stage-bearer + prefix. A flag's stage lives in its PARENT app's
	// physical name (`appName`), not its stage-invariant key — so a flag decodes off the
	// flagship app prefix applied to `appName`, never `name`.
	const {prefix, stageBearer} =
		resource.kind === "d1"
			? {prefix: D1_PREFIX, stageBearer: resource.name}
			: resource.kind === "flagship-app"
				? {prefix: FLAGSHIP_APP_NAME_PREFIX, stageBearer: resource.name}
				: resource.kind === "flagship-flag"
					? {prefix: FLAGSHIP_APP_NAME_PREFIX, stageBearer: resource.appName}
					: {prefix: WORKER_PREFIX, stageBearer: resource.name};
	if (!stageBearer.startsWith(prefix)) {
		return undefined;
	}
	const rest = stageBearer.slice(prefix.length);
	const lastDash = rest.lastIndexOf("-");
	// A name with no suffix segment (no dash after the prefix) is malformed for our
	// scheme — treat as unrecognized rather than guess a stage.
	if (lastDash <= 0) {
		return undefined;
	}
	return rest.slice(0, lastDash);
};

const isIntegrationStage = (stage: string): boolean => stage.startsWith("it-");

const previewPrNumber = (stage: string): number | undefined => {
	const m = /^pr-(\d+)$/.exec(stage);
	return m ? Number(m[1]) : undefined;
};

/** Why the dev/test family splits here: see the `sweepDevTestStages` docblock (#2340). */
const isNamedDevStage = (stage: string): boolean => stage === "dev" || stage.startsWith("dev-");
const isEphemeralTestStage = (stage: string): boolean =>
	stage === "test" || stage.startsWith("test-");

/**
 * Compute the deletion plan. The order of checks IS the safety policy: every protection
 * (unrecognized, `protectedStages`, named-dev) is tested BEFORE any allow-match, so a
 * protected stage can never be swept regardless of its name shape.
 */
export const computeSweepPlan = (
	resources: ReadonlyArray<CfResource>,
	protection: Protection,
): SweepPlan => {
	const protectedStages = new Set(protection.protectedStages);
	const openPrs = new Set(protection.openPrNumbers);
	const toDelete: Array<PlannedDelete> = [];
	const kept: Array<PlannedKeep> = [];

	for (const resource of resources) {
		const stage = decodeStage(resource);
		if (stage === undefined) {
			kept.push({resource, reason: "unrecognized"});
			continue;
		}
		if (protectedStages.has(stage)) {
			kept.push({resource, reason: "protected-stage"});
			continue;
		}
		// Named-dev (`dev-usirin`-shaped) is a protection: it must win before ANY sweep
		// branch below, so a dev stage is never deleted regardless of the opt-in (#2340).
		if (isNamedDevStage(stage)) {
			kept.push({resource, reason: "named-dev"});
			continue;
		}
		if (isIntegrationStage(stage)) {
			toDelete.push({resource, reason: "orphan-integration", stage});
			continue;
		}
		const pr = previewPrNumber(stage);
		if (pr !== undefined) {
			if (openPrs.has(pr)) {
				kept.push({resource, reason: "open-pr"});
			} else if (protection.sweepClosedPreviews) {
				toDelete.push({resource, reason: "closed-preview", stage});
			} else {
				kept.push({resource, reason: "preview-sweep-disabled"});
			}
			continue;
		}
		if (isEphemeralTestStage(stage)) {
			if (protection.sweepDevTestStages) {
				toDelete.push({resource, reason: "stale-dev-test", stage});
			} else {
				kept.push({resource, reason: "dev-test-sweep-disabled"});
			}
			continue;
		}
		kept.push({resource, reason: "unrecognized"});
	}

	return {toDelete, kept};
};
