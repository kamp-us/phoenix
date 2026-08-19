/**
 * user-admin wire shaper. `__typename` is stamped here because the entity is
 * inline-resolved — it has no source, so nothing else stamps it.
 */
import type {AdminUserRow} from "../pasaport/Pasaport.ts";
import type {UserAdminEntity, UserAdminRole} from "./views.ts";

/** Reads the `moderates` tuple, never the retired `user.role` column. */
export const roleOf = (isModerator: boolean): UserAdminRole =>
	isModerator ? "moderator" : "member";

/** A null column (the pre-column cohort) reads 0. */
export const createdAtMillis = (createdAt: Date | null): number => createdAt?.getTime() ?? 0;

export const toUserAdminRow = (
	row: AdminUserRow,
	opts: {readonly banned: boolean; readonly isModerator: boolean},
): UserAdminEntity => ({
	__typename: "UserAdmin",
	id: row.id,
	username: row.username,
	email: row.email,
	role: roleOf(opts.isModerator),
	banned: opts.banned,
	tier: row.tier,
	createdAt: createdAtMillis(row.createdAt),
});
