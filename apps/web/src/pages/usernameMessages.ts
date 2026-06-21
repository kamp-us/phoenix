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
import type {FateWireCode} from "../lib/fateWireCodes";

/** Map a server wire code (or a local rule reason) to its inline Turkish message. */
export function messageForCode(code: FateWireCode | null): string {
	switch (code) {
		case "TOO_SHORT":
			return "kullanıcı adı en az 3 karakter olmalı";
		case "TOO_LONG":
			return "kullanıcı adı en fazla 30 karakter olabilir";
		case "INVALID_FORMAT":
			return "kullanıcı adı yalnızca küçük harf, rakam ve - içerebilir";
		case "TAKEN":
			return "bu kullanıcı adı alınmış, başka bir tane dene";
		case "ALREADY_SET":
			return "kullanıcı adın zaten ayarlanmış";
		default:
			return "kullanıcı adı ayarlanamadı";
	}
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
