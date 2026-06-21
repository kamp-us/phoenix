/**
 * The single source of the username rule — the pure string predicate behind both
 * the server-authoritative `assertUsername` (`Pasaport.ts`) and the SPA's
 * client-side pre-flight (signup + bootstrap forms). No Effect/DO/worker coupling,
 * so `src/` can import it directly into the client bundle (the same neutral-pure
 * idiom as `flagship/evaluate-contract.ts`).
 *
 * `checkUsername` returns a {@link UsernameRuleCode} (or `null` when valid) keyed
 * to the same vocabulary the wire codes use, so the client maps a local rejection
 * and a server rejection through one `messageForCode` table — the rule and its
 * messaging never fork. The server stays authoritative: this is UX pre-flight; the
 * real gate is `setUsername` re-running `assertUsername` over the same rule.
 */

// 3-30 chars; lowercase ASCII letters, digits, and `-`; must start/end with a
// letter or digit (no leading/trailing `-`, no `--`).
const USERNAME_REGEX = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,28}[a-z0-9]$|^[a-z0-9]{3,30}$/;

/**
 * The seeded `@[silinen]` sentinel handle (ADR 0097 §1) — nobody may register it,
 * so it can never collide with the deletion tombstone. Rejected with the
 * `RESERVED` surface (the server maps it onto INVALID_FORMAT).
 */
export const SILINEN_USERNAME = "silinen";

const RESERVED_USERNAMES: ReadonlySet<string> = new Set([SILINEN_USERNAME]);

/** The non-valid outcomes of {@link checkUsername}, one per rejection reason. */
export type UsernameRuleCode = "RESERVED" | "TOO_SHORT" | "TOO_LONG" | "INVALID_FORMAT";

/**
 * Apply the username rule to an ALREADY-normalized (trimmed + lowercased) value.
 * Returns `null` when the value is a legal handle, or the first failing rule's
 * {@link UsernameRuleCode}. Order matches `assertUsername` so the local and server
 * verdicts agree on which reason wins.
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
 * Derive a default handle from an email local-part for the bootstrap fallback:
 * drop the `+tag` suffix (so a `+tag` address doesn't leak its tag into the public
 * handle), lowercase, map any non-`[a-z0-9-]` to `-`, strip leading/trailing and
 * collapse repeated `-`, and clamp to 30 chars. Best-effort — the result is only a
 * prefill; the user can edit it and the rule is still enforced on submit.
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
