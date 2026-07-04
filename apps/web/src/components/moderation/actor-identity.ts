/**
 * The moderation/admin shared component layer's pure render decisions, factored
 * DOM-free so each is unit-testable without a DOM/React runtime (the `flagGateChild`
 * / `karmaAriaLabel` idiom — `apps/web/src` has no jsdom).
 *
 * Home of the cross-surface actor-identity rule: every moderation/admin surface that
 * shows *who* an actor is (divan roster/detail today, the admin user-list #968 next)
 * renders the SAME handle + karma primitive rather than forking its own — ADR 0145,
 * grounded in ADR 0138's actor-centric spine.
 */

/**
 * The displayed handle for an actor row. Prefers a trimmed display name, falls back
 * to the `@username`, and degrades to the bare `fallback` label when both are
 * blank/absent (a since-deleted profile arrives as two nulls — the row must not
 * break, it shows the fallback noun). Whitespace-only is treated as absent. Pure so
 * the divan's `caylakLabel` and the admin user-list resolve the same handle through
 * one tested rule.
 */
export function actorLabel(
	displayName: string | null,
	username: string | null,
	fallback: string,
): string {
	if (displayName?.trim()) return displayName.trim();
	if (username?.trim()) return `@${username.trim()}`;
	return fallback;
}
