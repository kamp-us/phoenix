/**
 * The two platform roles are `member` / `moderator` only. `user.setRole` writes the `moderates`
 * tuple, so this toggle grants or revokes moderatör; there is no SPA-assignable `admin` role.
 */
import type {UserAdminRole} from "../../../worker/features/user-admin/views";
import type {FateWireCode} from "../../lib/fateWireCodes";

export const nextRole = (current: UserAdminRole): UserAdminRole =>
	current === "moderator" ? "member" : "moderator";

export const roleActionLabel = (current: UserAdminRole, busy: boolean): string => {
	if (current === "moderator") return busy ? "alınıyor…" : "moderatörlüğü al";
	return busy ? "yapılıyor…" : "moderatör yap";
};

/**
 * `UNAUTHORIZED` and `FORBIDDEN` deliberately share one message: a non-admin call and a
 * flag-off call must read the same, never leaking which of the two it was.
 */
export const roleOutcomeMessage = (
	assigned: UserAdminRole | null,
	code: FateWireCode | null,
): string => {
	if (code === null && assigned !== null) {
		return assigned === "moderator" ? "kullanıcı moderatör yapıldı." : "moderatörlük kaldırıldı.";
	}
	switch (code) {
		case "UNAUTHORIZED":
		case "FORBIDDEN":
			return "bu işlem için yetkin yok.";
		case "USER_NOT_FOUND":
			return "kullanıcı bulunamadı.";
		default:
			return "bir şeyler ters gitti, lütfen tekrar dene.";
	}
};
