/**
 * DOM-free render logic for the ban controls (#970, moderator UI epic #1665).
 * Pure so the label + outcome-message decisions are unit-testable without a DOM,
 * the divan-gating idiom (`divanGating.ts`); `BanControls.tsx` is the thin shell.
 */
import type {FateWireCode} from "../../lib/fateWireCodes";

/** The projected ban-state the controls render, as the wire delivers it. */
export interface BanView {
	readonly banned: boolean;
	readonly reason: string | null;
	/** Epoch-millis expiry, or null = permanent / not-banned. */
	readonly expiresAt: number | null;
}

/** The banned-state summary line — Turkish, text-only (never color-encoded). */
export const banStatusLabel = (state: BanView): string =>
	state.banned ? `yasaklı — gerekçe: ${state.reason ?? "belirtilmemiş"}` : "yasaklı değil";

/**
 * The ban expiry line, or null when there's nothing to show (not banned, or a
 * permanent ban). `nowMs` is injected so the "kalıcı" vs dated branch is pure.
 */
export const banExpiryLabel = (state: BanView): string | null => {
	if (!state.banned) return null;
	if (state.expiresAt === null) return "süre: kalıcı";
	return `süre bitişi: ${new Date(state.expiresAt).toLocaleString("tr-TR")}`;
};

/** Turkish feedback for a ban/unban mutation outcome, keyed on the wire code. */
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

/**
 * Parse the `datetime-local` input value to an epoch-millis expiry, or null when
 * empty (a permanent ban) or unparseable. The mutation takes epoch-millis; an
 * empty field is the deliberate "no expiry" choice, not an error.
 */
export const parseExpiry = (value: string): number | null => {
	const trimmed = value.trim();
	if (trimmed === "") return null;
	const ms = new Date(trimmed).getTime();
	return Number.isNaN(ms) ? null : ms;
};
