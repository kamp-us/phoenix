/**
 * The two platform roles are `member` / `moderator` only. `user.setRole` writes the `moderates`
 * tuple, so this toggle grants or revokes moderatör; there is no SPA-assignable `admin` role.
 */
import type {UserAdminRole} from "../../../worker/features/user-admin/views";
import type {CatalogKey} from "../../i18n";
import type {FateWireCode} from "../../lib/fateWireCodes";

export const nextRole = (current: UserAdminRole): UserAdminRole =>
	current === "moderator" ? "member" : "moderator";

export const roleActionLabelKey = (current: UserAdminRole, busy: boolean): CatalogKey => {
	if (current === "moderator") {
		return busy ? "admin.kullanicilar.role.demoting" : "admin.kullanicilar.role.demote";
	}
	return busy ? "admin.kullanicilar.role.promoting" : "admin.kullanicilar.role.promote";
};

/**
 * `UNAUTHORIZED` and `FORBIDDEN` deliberately share one message: a non-admin call and a
 * flag-off call must read the same, never leaking which of the two it was.
 */
export const roleOutcomeKey = (
	assigned: UserAdminRole | null,
	code: FateWireCode | null,
): CatalogKey => {
	if (code === null && assigned !== null) {
		return assigned === "moderator"
			? "admin.kullanicilar.role.promoted"
			: "admin.kullanicilar.role.demoted";
	}
	switch (code) {
		case "UNAUTHORIZED":
		case "FORBIDDEN":
			return "admin.kullanicilar.error.forbidden";
		case "USER_NOT_FOUND":
			return "admin.kullanicilar.error.notFound";
		default:
			return "admin.kullanicilar.error.generic";
	}
};
