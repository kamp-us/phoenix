/**
 * DOM-free render logic for the kullanıcılar (user-roster) admin module (#3200) — the
 * roster cell labels, pure so they are unit-testable without a DOM (the `email-delivery.ts`
 * idiom). `KullanicilarPanel.tsx` is the thin shell. Turkish user-facing copy per the
 * language rule (`.glossary/LANGUAGE.md`); the wire values stay English technical tokens.
 */
import type {UserAdminRole} from "../../../worker/features/user-admin/views";

/** The public handle cell — the username, or the not-yet-set note. */
export const usernameLabel = (username: string | null): string => username ?? "belirlenmemiş";

/** The role cell — the moderator/üye label off the relation-sourced `role` (never a column). */
export const roleLabel = (role: UserAdminRole): string =>
	role === "moderator" ? "moderatör" : "üye";

/** The ban-state cell — text, never color (design law pillar 4). */
export const banLabel = (banned: boolean): string => (banned ? "yasaklı" : "aktif");

/** The created-at cell — epoch-millis as a local date; the 0 sentinel (no column) reads unknown. */
export const createdAtLabel = (createdAt: number): string =>
	createdAt > 0 ? new Date(createdAt).toLocaleDateString("tr-TR") : "bilinmiyor";
