import type {CatalogKey, Locale} from "../../i18n";
import type {FateWireCode} from "../../lib/fateWireCodes";

/** `since` is epoch millis. */
export const sinceLabel = (since: number, locale: Locale): string =>
	new Date(since).toLocaleString(locale);

export const emailDeliveryOutcomeKey = (
	action: "mark" | "clear",
	code: FateWireCode | null,
): CatalogKey => {
	if (code === null) {
		return action === "mark"
			? "admin.emailDelivery.outcome.marked"
			: "admin.emailDelivery.outcome.cleared";
	}
	switch (code) {
		case "EMAIL_FAILING_REASON_REQUIRED":
			return "admin.emailDelivery.error.reasonRequired";
		case "UNAUTHORIZED":
		case "FORBIDDEN":
			return "admin.emailDelivery.error.forbidden";
		case "USER_NOT_FOUND":
			return "admin.emailDelivery.error.notFound";
		default:
			return "admin.emailDelivery.error.generic";
	}
};
