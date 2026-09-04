// Split from `BanControls.tsx` so these decisions are unit-testable — `apps/web/src` has no jsdom.
import type {CatalogKey, MessageParams} from "../../i18n";
import type {FateWireCode} from "../../lib/fateWireCodes";

export interface BanView {
	readonly banned: boolean;
	readonly reason: string | null;
	/** Epoch-millis expiry, or null = permanent / not-banned. */
	readonly expiresAt: number | null;
}

/** The catalog key a decision resolves to, plus whatever the copy interpolates (ADR 0347). */
export type BanMessage = {readonly key: CatalogKey; readonly params?: MessageParams};

export const banStatusLabel = (state: BanView): BanMessage => {
	if (!state.banned) return {key: "divan.ban.status.notBanned"};
	if (state.reason === null) return {key: "divan.ban.status.bannedNoReason"};
	return {key: "divan.ban.status.banned", params: {reason: state.reason}};
};

/** The expiry instant, not its text: only the component knows the reader's locale. */
export type BanExpiry =
	| {readonly kind: "permanent"}
	| {readonly kind: "until"; readonly at: number};

export const banExpiry = (state: BanView): BanExpiry | null => {
	if (!state.banned) return null;
	if (state.expiresAt === null) return {kind: "permanent"};
	return {kind: "until", at: state.expiresAt};
};

export const banOutcomeMessage = (
	action: "ban" | "unban",
	code: FateWireCode | null,
): CatalogKey => {
	if (code === null) {
		return action === "ban" ? "divan.ban.banned" : "divan.ban.unbanned";
	}
	switch (code) {
		case "BAN_REASON_REQUIRED":
			return "divan.ban.reasonRequired";
		case "UNAUTHORIZED":
		case "FORBIDDEN":
			return "divan.ban.forbidden";
		case "USER_NOT_FOUND":
			return "divan.ban.notFound";
		default:
			return "divan.ban.failed";
	}
};

// An empty field is the deliberate "permanent ban" choice, not an error.
export const parseExpiry = (value: string): number | null => {
	const trimmed = value.trim();
	if (trimmed === "") return null;
	const ms = new Date(trimmed).getTime();
	return Number.isNaN(ms) ? null : ms;
};
