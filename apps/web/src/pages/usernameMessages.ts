/**
 * Shared Turkish messaging for the username choice — used by BOTH the signup form
 * (`AuthPage`) and the post-signup fallback (`UsernameBootstrap`), so the two
 * surfaces never drift in copy or in the rule they pre-flight against.
 *
 * `localRuleMessage` runs the single-source {@link checkUsername} rule
 * (`worker/features/pasaport/username-rule.ts`, the same one `assertUsername`
 * enforces server-side) for client pre-flight; `messageForCode` maps a server wire
 * `code` back through the same table. The server stays authoritative — these are
 * the UX layer over it.
 */

import {checkUsername, normalizeUsername} from "../../worker/features/pasaport/username-rule";
import type {WireMessageOverrides} from "../fate/wireMessages";
import type {FateWireCode} from "../lib/fateWireCodes";

/**
 * The username surface's per-code copy. Unlike the other write surfaces (which
 * defer non-overridden codes to the shared {@link WIRE_MESSAGES} base, #1421), the
 * username form deliberately collapses *every* non-validation failure to one
 * generic line ({@link USERNAME_GENERIC}) — "couldn't set the username" is the
 * right surface message for an auth/server failure here, so this is a meaningful
 * per-surface default, not the #1422 silent-absorb. Only these five reasons get
 * distinct copy.
 */
const USERNAME_OVERRIDES: WireMessageOverrides = {
	TOO_SHORT: "kullanıcı adı en az 3 karakter olmalı",
	TOO_LONG: "kullanıcı adı en fazla 30 karakter olabilir",
	INVALID_FORMAT: "kullanıcı adı yalnızca küçük harf, rakam ve - içerebilir",
	TAKEN: "bu kullanıcı adı alınmış, başka bir tane dene",
	ALREADY_SET: "kullanıcı adın zaten ayarlanmış",
};

const USERNAME_GENERIC = "kullanıcı adı ayarlanamadı";

/** Map a server wire code (or a local rule reason) to its inline Turkish message. */
export function messageForCode(code: FateWireCode | null): string {
	return (code != null && USERNAME_OVERRIDES[code]) || USERNAME_GENERIC;
}

/**
 * Client-side pre-flight: normalize + run the shared rule, returning the inline
 * message for the first failing reason, or `null` when the value is a legal
 * handle. `RESERVED` shares the format message (the server maps it the same way).
 */
export function localRuleMessage(value: string): string | null {
	const code = checkUsername(normalizeUsername(value));
	if (code === null) return null;
	if (code === "RESERVED") return "bu kullanıcı adı ayrılmış ve kullanılamaz";
	return messageForCode(code);
}
