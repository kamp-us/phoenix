/**
 * Shared Turkish messaging for the username choice, used by both the signup form and the
 * post-signup fallback so the two can't drift in copy or in the rule they pre-flight. The
 * pre-flight runs the same rule module the server enforces; the server stays authoritative.
 */

import {checkUsername, normalizeUsername} from "../../worker/features/pasaport/username-rule";
import type {WireMessageOverrides} from "../fate/wireMessages";
import type {FateWireCode} from "../lib/fateWireCodes";

// Deliberately does NOT defer to the shared `WIRE_MESSAGES` base like the other write
// surfaces: every non-validation failure collapses to one generic line here, because
// "couldn't set the username" is the right thing to show for any of them (#1421/#1422).
const USERNAME_OVERRIDES: WireMessageOverrides = {
	TOO_SHORT: "kullanıcı adı en az 3 karakter olmalı",
	TOO_LONG: "kullanıcı adı en fazla 30 karakter olabilir",
	INVALID_FORMAT: "kullanıcı adı yalnızca küçük harf, rakam ve - içerebilir",
	TAKEN: "bu kullanıcı adı alınmış, başka bir tane dene",
	ALREADY_SET: "kullanıcı adın zaten ayarlanmış",
};

const USERNAME_GENERIC = "kullanıcı adı ayarlanamadı";

export function messageForCode(code: FateWireCode | null): string {
	return (code != null && USERNAME_OVERRIDES[code]) || USERNAME_GENERIC;
}

export function localRuleMessage(value: string): string | null {
	const code = checkUsername(normalizeUsername(value));
	if (code === null) return null;
	if (code === "RESERVED") return "bu kullanıcı adı ayrılmış ve kullanılamaz";
	return messageForCode(code);
}
