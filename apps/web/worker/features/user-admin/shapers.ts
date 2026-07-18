/**
 * user-admin wire shaper (#3200) — map one `AdminUserRow` (the pasaport record-derived
 * row) plus its joined `banned`/`role` standing onto the `UserAdmin` wire entity. Pure and
 * DOM-free: the `role` decision (`moderator` iff in the moderator set) and the epoch-millis
 * `createdAt` conversion are testable without a DB. The resolver joins the standing; this
 * stamps the wire shape. `__typename` is stamped here — the entity is inline-resolved (no
 * source), so nothing else stamps it (the `report/shapers.ts` idiom).
 */
import type {AdminUserRow} from "../pasaport/Pasaport.ts";
import type {UserAdminEntity, UserAdminRole} from "./views.ts";

/** `moderator` iff the account holds the `moderates` tuple, else `member` (never the retired column). */
export const roleOf = (isModerator: boolean): UserAdminRole =>
	isModerator ? "moderator" : "member";

/** The account's `created_at` as an epoch-millis wire scalar; a null column (pre-column cohort) reads 0. */
export const createdAtMillis = (createdAt: Date | null): number => createdAt?.getTime() ?? 0;

/** Map a roster row + its joined ban/moderator standing onto the `UserAdmin` wire entity. */
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
