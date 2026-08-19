/**
 * The single source of the username rule, shared by the server's `assertUsername` and the
 * SPA's pre-flight. No Effect/DO/worker coupling, so `src/` can import it into the client
 * bundle. The codes match the wire vocabulary, so a local and a server rejection map
 * through one message table. The server stays authoritative — this is UX pre-flight only.
 */

// 3-30 chars; lowercase ASCII letters, digits, and `-`; must start/end with a
// letter or digit (no leading/trailing `-`, no `--`).
const USERNAME_REGEX = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,28}[a-z0-9]$|^[a-z0-9]{3,30}$/;

/** Unregisterable so it can never collide with the deletion tombstone (ADR 0097 §1). */
export const SILINEN_USERNAME = "silinen";

const RESERVED_USERNAMES: ReadonlySet<string> = new Set([SILINEN_USERNAME]);

export type UsernameRuleCode = "RESERVED" | "TOO_SHORT" | "TOO_LONG" | "INVALID_FORMAT";

/**
 * Takes an ALREADY-normalized value. The check order matches `assertUsername` so the
 * local and server verdicts agree on which reason wins.
 */
export function checkUsername(normalized: string): UsernameRuleCode | null {
	if (RESERVED_USERNAMES.has(normalized)) return "RESERVED";
	if (normalized.length < 3) return "TOO_SHORT";
	if (normalized.length > 30) return "TOO_LONG";
	if (!USERNAME_REGEX.test(normalized)) return "INVALID_FORMAT";
	return null;
}

/** Normalize a raw input the same way `setUsername` does before checking it. */
export function normalizeUsername(raw: string): string {
	return raw.trim().toLowerCase();
}

/**
 * The `+tag` suffix is dropped so a tagged address doesn't leak its tag into the public
 * handle. Best-effort prefill only — the rule is still enforced on submit.
 */
export function deriveUsernameFromEmail(email: string): string {
	const localPart = email.split("@")[0] ?? "";
	const untagged = localPart.split("+")[0] ?? "";
	return untagged
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 30);
}
