/**
 * The ONE place a user's identity is flattened into the denormalized `authorName` column.
 *
 * The input type carries `{name, username}` ONLY — no `email` field — so the #2130
 * PII-at-rest leak (the old `user.name ?? user.email` persisting an EMAIL onto public
 * author surfaces) is closed at the type, not by a spot check per call site.
 *
 * The precedence mirrors the SPA's `actorLabel` exactly, so the persisted string and the
 * optimistic client author agree. The worker cannot import the SPA module, so the rule is
 * restated here with `author-label.unit.test.ts` as the lockstep guard.
 */

export const AUTHOR_FALLBACK_LABEL = "kullanıcı";

/** Deliberately carries no `email` field: email is structurally excluded from the label. */
export interface AuthorIdentity {
	readonly name?: string | null | undefined;
	readonly username?: string | null | undefined;
}

/** Whitespace-only is treated as absent. */
export function authorDisplayLabel(actor: AuthorIdentity): string {
	if (actor.name?.trim()) return actor.name.trim();
	if (actor.username?.trim()) return `@${actor.username.trim()}`;
	return AUTHOR_FALLBACK_LABEL;
}
