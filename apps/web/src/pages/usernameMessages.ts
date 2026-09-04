/**
 * Shared messaging for the username choice, used by both the signup form and the post-signup
 * fallback so the two can't drift in copy or in the rule they pre-flight. The pre-flight runs
 * the same rule module the server enforces; the server stays authoritative.
 *
 * The copy lives in `i18n/{tr,en}/wire.ts` under `wire.username.*`; this module is the lookup
 * from a code to its key. Deliberately does NOT defer to the shared wire base like the other
 * write surfaces: every failure this surface cannot name collapses to one generic line,
 * because "couldn't set the username" is the right thing to show for any of them (#1421/#1422).
 */

import {checkUsername, normalizeUsername} from "../../worker/features/pasaport/username-rule";
import type {Translate} from "../i18n/LocaleProvider";
import type {UsernameMessageCode, WireUsernameKey} from "../i18n/tr/wire";
import type {FateWireCode} from "../lib/fateWireCodes";

const NAMED_KEYS: Readonly<Record<UsernameMessageCode, WireUsernameKey>> = {
	TOO_SHORT: "wire.username.TOO_SHORT",
	TOO_LONG: "wire.username.TOO_LONG",
	INVALID_FORMAT: "wire.username.INVALID_FORMAT",
	RESERVED: "wire.username.RESERVED",
	TAKEN: "wire.username.TAKEN",
	ALREADY_SET: "wire.username.ALREADY_SET",
};

// Widened by annotation, not asserted: the exhaustive record above is what proves every named
// code has a key, and this alias is what lets the lookup take a code from either vocabulary.
const byCode: Readonly<Record<string, WireUsernameKey | undefined>> = NAMED_KEYS;

export function usernameMessageKey(
	code: FateWireCode | UsernameMessageCode | null,
): WireUsernameKey {
	return (code == null ? undefined : byCode[code]) ?? "wire.username.generic";
}

export function messageForCode(t: Translate, code: FateWireCode | null): string {
	return t(usernameMessageKey(code));
}

export function localRuleMessage(t: Translate, value: string): string | null {
	const code = checkUsername(normalizeUsername(value));
	return code === null ? null : t(usernameMessageKey(code));
}
