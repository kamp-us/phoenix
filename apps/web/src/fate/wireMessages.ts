/**
 * The shared client code→message registry (#1421).
 *
 * The `Record<FateWireCode, string>` typing is the point: it is exhaustive by
 * construction, so adding a code to `FATE_WIRE_CODES` without a message here is a
 * compile error rather than a silent generic fallback (#1422). Never loosen it, and
 * never give `messageForCode` a `default` arm.
 */
import {FATE_WIRE_CODES, type FateWireCode} from "../lib/fateWireCodes";

export const WIRE_MESSAGES: Record<FateWireCode, string> = {
	UNAUTHORIZED: "bu işlem için giriş yapmalısın",
	FORBIDDEN: "bunu yapma yetkin yok",
	VOTE_REQUIRES_YAZAR: "yazar olunca oy verebilirsin",
	SELF_VOTE_NOT_ALLOWED: "kendi içeriğine oy veremezsin",
	VOUCH_LIMIT_REACHED: "kefil olma sınırına ulaştın",
	INSUFFICIENT_KARMA: "bunu yapmak için karman yetersiz",
	RATE_LIMIT_EXCEEDED: "çok hızlısın, biraz yavaşla",
	DEFINITION_NOT_FOUND: "tanım bulunamadı",
	POST_NOT_FOUND: "başlık bulunamadı",
	POST_DELETE_FAILED: "gönderi silinemedi, lütfen tekrar dene",
	COMMENT_NOT_FOUND: "yorum bulunamadı",
	VALIDATION_ERROR: "girdiğin bilgiler geçersiz",
	BODY_REQUIRED: "içerik boş olamaz",
	BODY_TOO_LONG: "içerik çok uzun",
	TITLE_REQUIRED: "başlık boş olamaz",
	TITLE_TOO_LONG: "başlık çok uzun",
	URL_INVALID: "geçersiz bağlantı",
	TAGS_REQUIRED: "en az bir etiket seç",
	TAG_INVALID: "geçersiz etiket",
	PARENT_NOT_FOUND: "yanıtlanan içerik bulunamadı",
	INVALID_FORMAT: "geçersiz biçim",
	TOO_SHORT: "çok kısa",
	TOO_LONG: "çok uzun",
	ALREADY_SET: "zaten ayarlanmış",
	TAKEN: "bu değer alınmış",
	USER_NOT_FOUND: "kullanıcı bulunamadı",
	DISPLAY_NAME_EMPTY: "görünen ad boş olamaz",
	BAN_REASON_REQUIRED: "yasaklama gerekçesi zorunludur",
	EMAIL_FAILING_REASON_REQUIRED: "işaretleme gerekçesi zorunludur",
	MECMUA_DISABLED: "mecmua şu an kapalı",
	MECMUA_POST_NOT_FOUND: "yazı bulunamadı",
	MUTE_DISABLED: "sustur şu an kapalı",
	SELF_MUTE_REJECTED: "kendini susturamazsın",
	BAD_REQUEST: "geçersiz istek",
	INTERNAL_SERVER_ERROR: "bir şeyler ters gitti, lütfen tekrar dene",
};

/** Per-surface copy that wins over {@link WIRE_MESSAGES} for the codes it names. */
export type WireMessageOverrides = Partial<Record<FateWireCode, string>>;

export function messageForCode(code: FateWireCode, overrides?: WireMessageOverrides): string {
	return overrides?.[code] ?? WIRE_MESSAGES[code];
}

/** The wire-code vocabulary, re-exported so coverage tests have one import site. */
export {FATE_WIRE_CODES};
