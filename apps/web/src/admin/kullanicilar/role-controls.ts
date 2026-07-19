/**
 * DOM-free render logic for the kullanıcılar role-assign affordance (#3523) — the
 * grant/revoke toggle target, its label, and the outcome message, pure so they are
 * unit-testable without a DOM (the `ban-controls.ts` idiom). `RoleControls.tsx` is the
 * thin shell. Turkish user-facing copy per the language rule (`.glossary/LANGUAGE.md`);
 * the wire role values stay English technical tokens (`member` / `moderator`).
 *
 * The two platform roles are `member` / `moderator` only — the `user.setRole` mutation's
 * `SetRoleInput` (#3522) writes the `moderates` tuple, so the toggle grants or revokes the
 * moderatör role; there is no SPA-assignable `admin` role.
 */
import type {UserAdminRole} from "../../../worker/features/user-admin/views";
import type {FateWireCode} from "../../lib/fateWireCodes";

/** The role the toggle assigns next — grant moderatör to a üye, revoke it from a moderatör. */
export const nextRole = (current: UserAdminRole): UserAdminRole =>
	current === "moderator" ? "member" : "moderator";

/** The toggle's Turkish label, keyed on the current role and the in-flight state. */
export const roleActionLabel = (current: UserAdminRole, busy: boolean): string => {
	if (current === "moderator") return busy ? "alınıyor…" : "moderatörlüğü al";
	return busy ? "yapılıyor…" : "moderatör yap";
};

/**
 * Turkish feedback for a `user.setRole` outcome. On success (`code === null`) the
 * message is keyed on the newly-assigned role the mutation returns; on failure it is
 * keyed on the wire code — the invisible `Denied` (`UNAUTHORIZED`/`FORBIDDEN`, i.e. a
 * non-admin call OR the flag off) reads as a plain no-authority line, never leaking
 * which of the two it was.
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
