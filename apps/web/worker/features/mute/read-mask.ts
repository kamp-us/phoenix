/**
 * Mute read-mask (#3113) — the seam that makes a muted member's content disappear
 * from the muter's reads across pano + sözlük, the mute analogue of the çaylak
 * sandbox's viewer-scoped read filter (`SandboxVisibility.sandboxVisibleWhere`,
 * #1205). Three pieces, all viewer-scoped and off-by-default:
 *
 *   - {@link mutedAuthorsWhere} — the SQL read arm the connection/by-id reads `and()`
 *     beside their existing sandbox + removal guards: `author_id NOT IN (:muted)`.
 *     An empty/absent set contributes NO clause, so a flag-off read is byte-for-byte
 *     today's read.
 *   - {@link isMutedAuthor} — the in-memory dual for the single-row reads (`getPost`)
 *     that decide visibility after fetching one record.
 *   - {@link currentMutedIds} — the resolver-level read that resolves the muter's
 *     muted-id set once per request, gated behind the default-off `member-mute` flag
 *     (ADR 0083): off ⇒ the empty set ⇒ no mask. The mask is fully hidden, not a
 *     "muted" placeholder — matching the sandbox filter's hide (the issue's stated
 *     mask-vs-collapse choice).
 */
import {CurrentUser} from "@kampus/fate-effect";
import type {RuntimeContext} from "alchemy";
import {notInArray, type SQL, type SQLWrapper} from "drizzle-orm";
import {Effect} from "effect";
import {MEMBER_MUTE} from "../../../src/flags/keys.ts";
import {Flags} from "../flagship/Flags.ts";
import {provideRequestFlags, type RequestFlagOverrides} from "../flagship/FlagsContext.ts";
import {Mute} from "./Mute.ts";

/**
 * The read arm masking a muted member's rows: `author_id NOT IN (:muted)`, or
 * `undefined` when nothing is muted so drizzle's `and()` drops the term and the
 * read is unchanged. Kept beside the caller's own sandbox/removal guards, never
 * folded into them (the mute dimension is orthogonal, like the removal guard).
 */
export const mutedAuthorsWhere = (
	authorId: SQLWrapper,
	mutedIds: ReadonlySet<string> | undefined,
): SQL | undefined =>
	mutedIds && mutedIds.size > 0 ? notInArray(authorId, [...mutedIds]) : undefined;

/**
 * The in-memory dual of {@link mutedAuthorsWhere} for a read that has already
 * fetched one record (`getPost`): `true` iff the row's author is in the muter's
 * muted set, so the caller masks it to not-found.
 */
export const isMutedAuthor = (
	authorId: string,
	mutedIds: ReadonlySet<string> | undefined,
): boolean => mutedIds != null && mutedIds.has(authorId);

/**
 * The muter's muted-id set for this request — the viewer-scoped mask the content
 * resolvers thread into their reads. Gated behind the default-off `member-mute`
 * flag (safe-default: a Flagship outage or the unflipped default both read `false`,
 * so reads are exactly as today). An anonymous viewer (no `CurrentUser`) has no
 * mutes, short-circuiting to the empty set with no DB read.
 */
export const currentMutedIds: Effect.Effect<
	Set<string>,
	never,
	Flags | RuntimeContext | RequestFlagOverrides | CurrentUser | Mute
> = Effect.gen(function* () {
	const flags = yield* Flags;
	const on = yield* flags.getBoolean(MEMBER_MUTE, false).pipe(provideRequestFlags);
	if (!on) return new Set<string>();
	const {user} = yield* CurrentUser;
	if (!user?.id) return new Set<string>();
	const mute = yield* Mute;
	return yield* mute.readMutedIds(user.id);
});
