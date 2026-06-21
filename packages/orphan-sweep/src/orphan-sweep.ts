/**
 * `@kampus/orphan-sweep` pure core — turn the live set of Cloudflare resources into a
 * deletion plan that bounds the integration-stage leak (#690) WITHOUT ever touching a
 * protected resource. IO-free and total: every function here is a deterministic
 * transform over already-listed `CfResource[]` + a protection set; the CF/`gh`
 * boundary lives in `cloudflare.ts`/`github.ts`, and this module never deletes
 * anything itself.
 *
 * Why a leak exists (#690, carved out of #689): integration teardown is
 * `afterAll(destroy(...))`. A partial `beforeAll` deploy can orphan its remote D1; the
 * #689 run-unique stage names mean a later run never overwrites it, so orphans
 * ACCUMULATE on the one shared account. This sweep is the bound: it deletes the
 * ephemeral integration (`it-*`) resources and the preview (`pr-<n>`) resources of
 * CLOSED PRs, and protects everything else.
 *
 * The safety property is the whole point. A sweep that deletes a prod, named-dev, or
 * open-PR resource is catastrophic and irreversible (ADR 0032: these are REAL remote
 * D1s, never emulated). So matching is allow-by-pattern + deny-by-protection, both
 * anchored, and exhaustively unit-tested.
 */

/** A Cloudflare resource as listed at the boundary, reduced to what the plan needs. */
export interface CfResource {
	/** Worker scripts and D1 databases are the two leaking kinds; each is swept by its own anchor. */
	readonly kind: "worker" | "d1";
	/** The physical CF name, e.g. `phoenix-phoenix-it-report-1a2b3c4d` (see name shape below). */
	readonly name: string;
}

/**
 * The protection set: the resources that must NEVER be deleted, expressed as the
 * stage-shaped facts the matcher needs. The plan is deny-by-default for anything that
 * matches a protected pattern, BEFORE any allow-pattern is consulted.
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
}

/** Why a resource is in the plan — the audit trail, so the plan is never an opaque list. */
export type DeleteReason = "orphan-integration" | "closed-preview";

export type KeepReason = "protected-stage" | "open-pr" | "unrecognized" | "preview-sweep-disabled";

export interface PlannedDelete {
	readonly resource: CfResource;
	readonly reason: DeleteReason;
	/** The stage the physical name decoded to, for the report. */
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
	const prefix = resource.kind === "d1" ? D1_PREFIX : WORKER_PREFIX;
	if (!resource.name.startsWith(prefix)) {
		return undefined;
	}
	const rest = resource.name.slice(prefix.length);
	const lastDash = rest.lastIndexOf("-");
	// A name with no suffix segment (no dash after the prefix) is malformed for our
	// scheme — treat as unrecognized rather than guess a stage.
	if (lastDash <= 0) {
		return undefined;
	}
	return rest.slice(0, lastDash);
};

/** A stage is an ephemeral integration stage iff it is `it-…` (anchored, never a substring). */
const isIntegrationStage = (stage: string): boolean => stage.startsWith("it-");

/**
 * If the stage is a preview `pr-<n>`, return `n`; else `undefined`. Anchored so only a
 * literal `pr-<digits>` with NOTHING after the number matches — `pr-12` yes, `prod` no,
 * `pr-12-foo` no, `pr-` no.
 */
const previewPrNumber = (stage: string): number | undefined => {
	const m = /^pr-(\d+)$/.exec(stage);
	return m ? Number(m[1]) : undefined;
};

/**
 * Compute the deletion plan. The order of checks IS the safety policy:
 *
 *   1. Unrecognized (not one of our resources) → KEPT. Nothing foreign is ever swept.
 *   2. The decoded stage is in `protectedStages` (prod, named-dev) → KEPT. This wins
 *      even over an `it-`/`pr-` allow-match, so a stage someone deliberately protected
 *      can never be swept regardless of its name shape.
 *   3. `it-*` integration stage → DELETE (`orphan-integration`).
 *   4. `pr-<n>` preview: open PR → KEPT (`open-pr`). Closed PR → DELETE only if
 *      `sweepClosedPreviews`, else KEPT (`preview-sweep-disabled`).
 *   5. Anything else recognized but not matched → KEPT (`unrecognized`).
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
		kept.push({resource, reason: "unrecognized"});
	}

	return {toDelete, kept};
};
