/**
 * DOM-free render logic for the email-delivery admin module (#2732, email-bounce epic
 * #2687) — the roll-up row labels + the mark/clear outcome-message mapping, pure so they
 * are unit-testable without a DOM (the `ban-controls.ts` idiom). `EmailDeliveryPanel.tsx`
 * is the thin shell.
 */
import type {FateWireCode} from "../../lib/fateWireCodes";

/** The resolved-account cell — the user id, or the "no account row" note when unresolved. */
export const resolvedUserLabel = (userId: string | null): string => userId ?? "hesap yok";

/** The active-reason cell, falling back to the not-stated note (mirrors `banStatusLabel`). */
export const reasonLabel = (reason: string | null): string => reason ?? "belirtilmemiş";

/** The since cell — epoch-millis rendered as a local date/time (text, never color). */
export const sinceLabel = (since: number): string => new Date(since).toLocaleString("tr-TR");

/** Turkish feedback for a mark/clear mutation outcome, keyed on the wire code. */
export const emailDeliveryOutcomeMessage = (
	action: "mark" | "clear",
	code: FateWireCode | null,
): string => {
	if (code === null) {
		return action === "mark" ? "adres işaretlendi." : "işaret temizlendi.";
	}
	switch (code) {
		case "EMAIL_FAILING_REASON_REQUIRED":
			return "işaretleme gerekçesi zorunludur.";
		case "UNAUTHORIZED":
		case "FORBIDDEN":
			return "bu işlem için yetkin yok.";
		case "USER_NOT_FOUND":
			return "kullanıcı bulunamadı.";
		default:
			return "bir şeyler ters gitti, lütfen tekrar dene.";
	}
};
