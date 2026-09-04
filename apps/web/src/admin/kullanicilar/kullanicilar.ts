import type {UserAdminRole} from "../../../worker/features/user-admin/views";
import type {CatalogKey, Locale} from "../../i18n";

export const roleLabelKey = (role: UserAdminRole): CatalogKey =>
	role === "moderator" ? "admin.kullanicilar.role.moderator" : "admin.kullanicilar.role.member";

export const banLabelKey = (banned: boolean): CatalogKey =>
	banned ? "admin.kullanicilar.ban.banned" : "admin.kullanicilar.ban.active";

/** `createdAt` is epoch millis; 0 is the no-column sentinel the panel reads as unknown. */
export const hasCreatedAt = (createdAt: number): boolean => createdAt > 0;

export const createdAtLabel = (createdAt: number, locale: Locale): string =>
	new Date(createdAt).toLocaleDateString(locale);
