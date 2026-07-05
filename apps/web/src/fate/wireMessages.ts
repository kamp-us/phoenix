/**
 * The shared client code→message adapter: one exhaustive {@link FateWireCode}→
 * Turkish-copy registry, replacing the six scattered `switch (code) { … default }`
 * blocks that used to live one-per-surface (#1421).
 *
 * `WIRE_MESSAGES` is typed `Record<FateWireCode, string>` — **exhaustive by
 * construction**: adding a code to `FATE_WIRE_CODES` without a message here is a
 * compile error, not a silent generic fallback. That is the structural close of
 * the #1422 class (a new code can no longer fall through every site to a `default`).
 *
 * A surface that needs different copy for a code (the char-limit phrasings, the
 * per-entity "boş olamaz"/"bulunamadı" nouns) passes an `overrides` map; the
 * authored per-surface copy wins over the shared base. `messageForCode` is total —
 * it always resolves to a real message, so call sites never thread a fallback for
 * a *known* code. The submit envelope's `failureFallback` (see
 * {@link useDraftSubmit}) is a separate concept: the generic "operation failed"
 * line for an unexpected boundary throw, not a per-code message.
 */
import {FATE_WIRE_CODES, type FateWireCode} from "../lib/fateWireCodes";

/**
 * The shared base message for every wire code. Exhaustive over `FateWireCode`
 * (the `Record` type enforces it) — a surface overrides an entry only when its
 * copy genuinely differs.
 */
export const WIRE_MESSAGES: Record<FateWireCode, string> = {
	UNAUTHORIZED: "bu işlem için giriş yapmalısın",
	FORBIDDEN: "bunu yapma yetkin yok",
	VOTE_REQUIRES_YAZAR: "yazar olunca oy verebilirsin",
	VOUCH_LIMIT_REACHED: "kefil olma sınırına ulaştın",
	INSUFFICIENT_KARMA: "bunu yapmak için karman yetersiz",
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
	DRAFTS_DISABLED: "taslaklar şu an devre dışı",
	REACTIONS_DISABLED: "tepkiler şu an devre dışı",
	PARENT_NOT_FOUND: "yanıtlanan içerik bulunamadı",
	INVALID_FORMAT: "geçersiz biçim",
	TOO_SHORT: "çok kısa",
	TOO_LONG: "çok uzun",
	ALREADY_SET: "zaten ayarlanmış",
	TAKEN: "bu değer alınmış",
	USER_NOT_FOUND: "kullanıcı bulunamadı",
	BAD_REQUEST: "geçersiz istek",
	INTERNAL_SERVER_ERROR: "bir şeyler ters gitti, lütfen tekrar dene",
};

/** Per-surface copy that wins over {@link WIRE_MESSAGES} for the codes it names. */
export type WireMessageOverrides = Partial<Record<FateWireCode, string>>;

/**
 * Resolve a wire code to its inline message: the surface `overrides` entry if it
 * has one, else the shared base. Total — every code resolves, so there is no
 * trailing `default` to silently absorb a new code.
 */
export function messageForCode(code: FateWireCode, overrides?: WireMessageOverrides): string {
	return overrides?.[code] ?? WIRE_MESSAGES[code];
}

/** The wire-code vocabulary, re-exported so coverage tests have one import site. */
export {FATE_WIRE_CODES};
