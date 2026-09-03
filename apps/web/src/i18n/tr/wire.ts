/**
 * The wire-code surface: one message per `FateWireCode`, plus the username choice's own
 * override copy. `WireCodeKey` is a template-literal type over the code vocabulary, so the
 * `Record<WireCodeKey, string>` annotation below is exhaustive in BOTH directions — a code
 * with no message and a message naming no code are each a compile error. That is the #1422
 * guarantee `fate/wireMessages.ts` used to hold, kept here now that the copy lives in the
 * catalog.
 */

import type {UsernameRuleCode} from "../../../worker/features/pasaport/username-rule";
import type {FateWireCode} from "../../lib/fateWireCodes";

export type WireCodeKey = `wire.${FateWireCode}`;

const codes: Record<WireCodeKey, string> = {
	"wire.UNAUTHORIZED": "bu işlem için giriş yapmalısın",
	"wire.FORBIDDEN": "bunu yapma yetkin yok",
	"wire.VOTE_REQUIRES_YAZAR": "yazar olunca oy verebilirsin",
	"wire.SELF_VOTE_NOT_ALLOWED": "kendi içeriğine oy veremezsin",
	"wire.VOUCH_LIMIT_REACHED": "kefil olma sınırına ulaştın",
	"wire.INSUFFICIENT_KARMA": "bunu yapmak için karman yetersiz",
	"wire.RATE_LIMIT_EXCEEDED": "çok hızlısın, biraz yavaşla",
	"wire.DEFINITION_NOT_FOUND": "tanım bulunamadı",
	"wire.POST_NOT_FOUND": "başlık bulunamadı",
	"wire.POST_DELETE_FAILED": "gönderi silinemedi, lütfen tekrar dene",
	"wire.COMMENT_NOT_FOUND": "yorum bulunamadı",
	"wire.VALIDATION_ERROR": "girdiğin bilgiler geçersiz",
	"wire.BODY_REQUIRED": "içerik boş olamaz",
	"wire.BODY_TOO_LONG": "içerik çok uzun",
	"wire.TITLE_REQUIRED": "başlık boş olamaz",
	"wire.TITLE_TOO_LONG": "başlık çok uzun",
	"wire.URL_INVALID": "geçersiz bağlantı",
	"wire.TAGS_REQUIRED": "en az bir etiket seç",
	"wire.TAG_INVALID": "geçersiz etiket",
	"wire.PARENT_NOT_FOUND": "yanıtlanan içerik bulunamadı",
	"wire.INVALID_FORMAT": "geçersiz biçim",
	"wire.TOO_SHORT": "çok kısa",
	"wire.TOO_LONG": "çok uzun",
	"wire.ALREADY_SET": "zaten ayarlanmış",
	"wire.TAKEN": "bu değer alınmış",
	"wire.USER_NOT_FOUND": "kullanıcı bulunamadı",
	"wire.DISPLAY_NAME_EMPTY": "görünen ad boş olamaz",
	"wire.BAN_REASON_REQUIRED": "yasaklama gerekçesi zorunludur",
	"wire.EMAIL_FAILING_REASON_REQUIRED": "işaretleme gerekçesi zorunludur",
	"wire.MECMUA_DISABLED": "mecmua şu an kapalı",
	"wire.MECMUA_POST_NOT_FOUND": "yazı bulunamadı",
	"wire.MUTE_DISABLED": "sustur şu an kapalı",
	"wire.SELF_MUTE_REJECTED": "kendini susturamazsın",
	"wire.BAD_REQUEST": "geçersiz istek",
	"wire.INTERNAL_SERVER_ERROR": "bir şeyler ters gitti, lütfen tekrar dene",
};

/**
 * The codes the username choice speaks for. `RESERVED` is a local-rule verdict that never
 * crosses the wire, and `TAKEN` / `ALREADY_SET` are wire codes the local rule cannot reach,
 * so the union is neither vocabulary on its own.
 */
export type UsernameMessageCode = UsernameRuleCode | "TAKEN" | "ALREADY_SET";

export type WireUsernameKey = `wire.username.${UsernameMessageCode}` | "wire.username.generic";

// Every non-validation failure of the handle collapses to `generic`: "couldn't set the
// username" is the right thing to show for any of them, which is why this surface overrides
// the shared base rather than deferring to it (#1421/#1422).
const username: Record<WireUsernameKey, string> = {
	"wire.username.TOO_SHORT": "kullanıcı adı en az 3 karakter olmalı",
	"wire.username.TOO_LONG": "kullanıcı adı en fazla 30 karakter olabilir",
	"wire.username.INVALID_FORMAT": "kullanıcı adı yalnızca küçük harf, rakam ve - içerebilir",
	"wire.username.RESERVED": "bu kullanıcı adı ayrılmış ve kullanılamaz",
	"wire.username.TAKEN": "bu kullanıcı adı alınmış, başka bir tane dene",
	"wire.username.ALREADY_SET": "kullanıcı adın zaten ayarlanmış",
	"wire.username.generic": "kullanıcı adı ayarlanamadı",
};

export const wire = {
	...codes,
	...username,
};

/** `tr` is the source of truth for the key set; `en/wire.ts` is checked against this. */
export type WireKey = keyof typeof wire;
