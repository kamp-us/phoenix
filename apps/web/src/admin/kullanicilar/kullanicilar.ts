import type {UserAdminRole} from "../../../worker/features/user-admin/views";

export const usernameLabel = (username: string | null): string => username ?? "belirlenmemiş";

export const roleLabel = (role: UserAdminRole): string =>
	role === "moderator" ? "moderatör" : "üye";

export const banLabel = (banned: boolean): string => (banned ? "yasaklı" : "aktif");

/** `createdAt` is epoch millis; 0 is the no-column sentinel and reads as unknown. */
export const createdAtLabel = (createdAt: number): string =>
	createdAt > 0 ? new Date(createdAt).toLocaleDateString("tr-TR") : "bilinmiyor";
