/**
 * The CI token's Cloudflare permission groups — the single source for the grant set
 * `github.ts` hands `Cloudflare.AccountApiToken`. Each grant is PAIRED with the stack
 * resource that backs it, so the literal `permissionGroups` array is *derived*
 * (`permissionGroupNames`) rather than hand-duplicated, and a group can't be added
 * without naming what it's for.
 *
 * The pair structure makes the standing over-grant unrepresentable (#1437): an
 * ahead-of-resource grant has nothing to write in `backedBy`, so `unbackedGrants`
 * catches a blank one and `permission-groups.unit.test.ts` fails on it. The granted set
 * is no longer a prose-coupled second list against `apps/web/alchemy.run.ts`'s resources
 * — it is one annotated list a reviewer reads top-to-bottom.
 *
 * `Workers R2 Storage Write` is absent on purpose: ADR 0044's imge bucket is
 * designed-not-built, so nothing in `apps/web/alchemy.run.ts` (a Worker, D1, the LiveDO,
 * the hosted state-store KV, `send_email`) declares an R2 bucket to back it. Re-add its
 * entry here in the same PR that lands the first real `Cloudflare.R2Bucket` resource.
 *
 * Out of scope (and not a backing-resource concern): `deploy.yml`'s per-app
 * `needs-auth` matrix flag is a *different* contract — which app binds
 * `BETTER_AUTH_SECRET` — already tracked by the `CI-secret roster` cross-pointer in
 * `github.ts`, not the Cloudflare permission set this module governs.
 */

import type {PermissionGroupName} from "alchemy/Cloudflare";

/** A CI-token permission group paired with the declared stack resource it's granted for. */
export interface BackedPermissionGroup {
	/**
	 * The Cloudflare permission-group name passed to `AccountApiToken`. Typed against
	 * alchemy's static catalog (`PermissionGroupName`), so a typo is a compile error.
	 */
	readonly group: PermissionGroupName;
	/** The declared `apps/web/alchemy.run.ts` resource this grant exists to deploy — never blank. */
	readonly backedBy: string;
}

/**
 * The granted permission groups, each tied to its backing resource. Adding a binding to
 * the app stack means adding its grant here with the resource it backs; removing the last
 * user of a permission means removing its row. There is no second list to keep in sync.
 */
export const CI_TOKEN_PERMISSION_GROUPS: readonly BackedPermissionGroup[] = [
	{
		group: "Workers Scripts Write",
		backedBy: "the Phoenix worker (worker/index.ts) + its LiveDO and uploaded dist/client assets",
	},
	{
		group: "Workers KV Storage Write",
		backedBy: "the Cloudflare.state() hosted state-store's KV metadata",
	},
	{group: "D1 Write", backedBy: "PhoenixDb (worker/db/resources.ts)"},
	{group: "Workers Tail Read", backedBy: "deploy-time worker tail logs"},
	{group: "Account Settings Read", backedBy: "account settings read during deploy"},
	{
		group: "Secrets Store Read",
		backedBy: "Cloudflare.state() store bearer token + AES key (adopted on every deploy)",
	},
	{
		group: "Secrets Store Write",
		backedBy: "Cloudflare.state() store bearer token + AES key (refreshed on every deploy)",
	},
];

/** The literal permission-group names — what `AccountApiToken`'s `permissionGroups` expects. */
export const permissionGroupNames = (
	groups: readonly BackedPermissionGroup[] = CI_TOKEN_PERMISSION_GROUPS,
): PermissionGroupName[] => groups.map((g) => g.group);

/**
 * The granted groups with no backing resource (a blank `backedBy`) — an ahead-of-resource
 * over-grant, the least-privilege drift this module exists to make impossible. An empty
 * result is the invariant holding; a non-empty result is a grant to drop (or back).
 */
export const unbackedGrants = (
	groups: readonly BackedPermissionGroup[] = CI_TOKEN_PERMISSION_GROUPS,
): string[] => groups.filter((g) => g.backedBy.trim() === "").map((g) => g.group);
