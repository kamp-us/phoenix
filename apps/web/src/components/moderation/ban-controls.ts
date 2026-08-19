// Split from `BanControls.tsx` so these decisions are unit-testable — `apps/web/src` has no jsdom.
import type {FateWireCode} from "../../lib/fateWireCodes";

export interface BanView {
	readonly banned: boolean;
	readonly reason: string | null;
	/** Epoch-millis expiry, or null = permanent / not-banned. */
	readonly expiresAt: number | null;
}

export const banStatusLabel = (state: BanView): string =>
	state.banned ? `yasaklı — gerekçe: ${state.reason ?? "belirtilmemiş"}` : "yasaklı değil";

export const banExpiryLabel = (state: BanView): string | null => {
	if (!state.banned) return null;
	if (state.expiresAt === null) return "süre: kalıcı";
	return `süre bitişi: ${new Date(state.expiresAt).toLocaleString("tr-TR")}`;
};

export const banOutcomeMessage = (action: "ban" | "unban", code: FateWireCode | null): string => {
	if (code === null) {
		return action === "ban" ? "kullanıcı yasaklandı." : "yasak kaldırıldı.";
	}
	switch (code) {
		case "BAN_REASON_REQUIRED":
			return "yasaklama gerekçesi zorunludur.";
		case "UNAUTHORIZED":
		case "FORBIDDEN":
			return "bu işlem için yetkin yok.";
		case "USER_NOT_FOUND":
			return "kullanıcı bulunamadı.";
		default:
			return "bir şeyler ters gitti, lütfen tekrar dene.";
	}
};

// An empty field is the deliberate "permanent ban" choice, not an error.
export const parseExpiry = (value: string): number | null => {
	const trimmed = value.trim();
	if (trimmed === "") return null;
	const ms = new Date(trimmed).getTime();
	return Number.isNaN(ms) ? null : ms;
};
