/**
 * The write-boundary author-label rule: the ONE place a signed-in user's identity
 * is flattened into the denormalized `authorName` column persisted on
 * `definition_record` / `post_record` / `comment_record`.
 *
 * It exists to make an invalid state unrepresentable — an email in a public
 * display column (the #2130 PII-at-rest leak, where the old
 * `authorName: user.name ?? user.email` persisted a null-name account's EMAIL and
 * served it on the public author surfaces). The input is a typed
 * {@link AuthorIdentity} snapshot of `{name, username}` ONLY; `email` is not a
 * field, so no write path can pass it as a fallback here — the leak is closed at
 * the type, not by a spot check at each call site.
 *
 * The precedence mirrors the SPA read surface's `actorLabel`
 * (`apps/web/src/components/moderation/actor-identity.ts`) exactly — display name →
 * `@username` → the fixed `kullanıcı` fallback noun — so the persisted string and
 * the optimistic client author (#2129, `actorLabel(user.name, …, "kullanıcı")`)
 * agree by construction. The two rules are kept in parity by
 * `author-label.unit.test.ts`; the worker cannot import the SPA module (no
 * worker→src dependency), so the pure rule is restated here with that test as the
 * lockstep guard. Threading the full `{username, displayName}` snapshot through the
 * fate views so the READ surfaces call `actorLabel` on live identity (finishing
 * #2126 for the denormalized surfaces) is the separately-tracked follow-up.
 */

/** The fixed fallback noun for an actor with neither a display name nor a username. */
export const AUTHOR_FALLBACK_LABEL = "kullanıcı";

/**
 * The non-PII identity snapshot a write path flattens into `authorName`. Deliberately
 * carries no `email` field: email is structurally excluded from the display label.
 */
export interface AuthorIdentity {
	readonly name?: string | null | undefined;
	readonly username?: string | null | undefined;
}

/**
 * Resolve the persisted author display label from a `{name, username}` snapshot:
 * trimmed display name → `@username` → the fixed `kullanıcı` fallback. Whitespace-only
 * is treated as absent. Never returns an email — email is not an input.
 */
export function authorDisplayLabel(actor: AuthorIdentity): string {
	if (actor.name?.trim()) return actor.name.trim();
	if (actor.username?.trim()) return `@${actor.username.trim()}`;
	return AUTHOR_FALLBACK_LABEL;
}
