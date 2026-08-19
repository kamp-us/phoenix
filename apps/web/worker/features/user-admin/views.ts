/**
 * One row of the gated admin user roster (#3200) — an account's admin-facing standing.
 *
 * `role` and `tier` are joined by the resolver, NOT read off the retired `user.role` column (ADR
 * 0107 §4): `role` is `moderator` iff the account holds the `moderates` relation tuple, `tier` is
 * the stored authorship rank; `banned` is projected from the append-only `user_ban_event` log.
 *
 * The row carries only roster fields — no session, no capability list — and is only ever produced
 * past the `requireAdmin` gate + the `phoenix-user-admin` dark-ship flag (`lists.ts`).
 */
import {FateDataView, type WorkerEntity} from "@kampus/fate-effect";
import type {ViewRow} from "../fate/view-types.ts";
import type {StoredTier} from "../kunye/standing.ts";

export type UserAdminRole = "member" | "moderator";

export type UserAdminViewRow = ViewRow<{
	id: string;
	username: string | null;
	email: string;
	role: UserAdminRole;
	banned: boolean;
	tier: StoredTier;
	createdAt: number;
}>;

export class UserAdminView extends FateDataView<UserAdminViewRow>()("UserAdmin")({
	id: true,
	username: true,
	email: true,
	role: true,
	banned: true,
	tier: true,
	createdAt: true,
} satisfies {[K in keyof UserAdminViewRow]: true}) {}

export const userAdminDataView = UserAdminView.view;

export type UserAdminEntity = WorkerEntity<typeof UserAdminView>;
