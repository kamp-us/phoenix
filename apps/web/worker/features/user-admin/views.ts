/**
 * user-admin fate data view — `UserAdminView`, one row of the gated admin user roster
 * (#3200). The read view the `kullanıcılar` console module lists: one account's
 * admin-facing standing — id, username, email, `role`, `banned`, `tier`, `createdAt`.
 *
 * `id` === the account id (the client normalization key). `role` and `tier` are the
 * standing fields joined by the resolver, NOT read off the retired `user.role` column
 * (ADR 0107 §4): `role` is `moderator` iff the account holds the `moderates` relation
 * tuple (`moderatorsAmong`), `tier` is the stored authorship rank read fresh through
 * pasaport; `banned` is projected from the append-only `user_ban_event` log
 * (`pasaport/ban.ts`). `createdAt` is epoch-millis to keep the wire scalar plain.
 *
 * The row carries only the admin roster fields — no session, no capability list. It is
 * only ever produced past the `requireAdmin` gate + the `phoenix-user-admin` dark-ship
 * flag (`lists.ts`), so a non-admin gets the invisible `Denied` rather than a leaked row.
 */
import {FateDataView, type WorkerEntity} from "@kampus/fate-effect";
import type {ViewRow} from "../fate/view-types.ts";
import type {StoredTier} from "../kunye/standing.ts";

/** The admin-facing role signal — `moderator` iff the `moderates` tuple is held, else `member`. */
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
