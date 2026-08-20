import type {FateWireCode} from "../../lib/fateWireCodes";

export const resolvedUserLabel = (userId: string | null): string => userId ?? "hesap yok";

export const reasonLabel = (reason: string | null): string => reason ?? "belirtilmemiş";

/** `since` is epoch millis. */
export const sinceLabel = (since: number): string => new Date(since).toLocaleString("tr-TR");

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
