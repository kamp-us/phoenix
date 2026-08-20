/**
 * Mute read-mask (#3113) — makes a muted member's content disappear from the muter's
 * reads, the mute analogue of the sandbox's viewer-scoped filter (#1205). Viewer-scoped
 * and off-by-default: an empty set contributes no clause, so a flag-off read is
 * byte-for-byte today's read. Muted content is fully hidden, never a "muted" placeholder.
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
 * Returns `undefined` when nothing is muted so drizzle's `and()` drops the term. Keep it
 * beside the caller's sandbox/removal guards, never folded into them — mute is an
 * orthogonal dimension.
 */
export const mutedAuthorsWhere = (
	authorId: SQLWrapper,
	mutedIds: ReadonlySet<string> | undefined,
): SQL | undefined =>
	mutedIds && mutedIds.size > 0 ? notInArray(authorId, [...mutedIds]) : undefined;

/** The in-memory dual of {@link mutedAuthorsWhere}, for reads that fetch one record. */
export const isMutedAuthor = (
	authorId: string,
	mutedIds: ReadonlySet<string> | undefined,
): boolean => mutedIds?.has(authorId) ?? false;

/**
 * Safe-default `false`: a Flagship outage and the unflipped default both leave reads
 * exactly as today.
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
