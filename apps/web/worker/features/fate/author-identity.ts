/**
 * `stampAuthorIdentity` — the author-identity analogue of `stampReactionAggregate`
 * (`reaction-aggregate.ts`) and `stampViewerScalars` (`viewer-scalars.ts`), for the
 * two live-identity wire fields the `definition` / `post` / `comment` fate views
 * expose so the denormalized author surfaces render the author's CURRENT handle
 * rather than the write-time `authorName` snapshot (#2139, completing #2126's
 * display-consistency AC for the surfaces #2126/#2130 deferred).
 *
 * The write-time `authorName` snapshot exists to avoid a per-row user join, so
 * resolving the LIVE `{username, displayName}` is a join — but a BATCHED one, the
 * same N+1-avoidance shape the sibling stampers use: ONE `Pasaport.getProfileIdentitiesByIds`
 * read (`SELECT … FROM user_profile WHERE user_id IN (…)`) for the whole page,
 * keyed by `authorId`, never a per-row read. This is the exact idiom Divan's
 * `roster` and report's `resolveResolverHandles` already use (`getProfileIdentitiesByIds`).
 *
 * A row whose author has no profile row (or no username/displayName yet) is stamped
 * with nulls; the client's `actorLabel(displayName, username, fallback)` then degrades
 * to `@username` → the fixed fallback noun. The account-deletion `@[silinen]` sentinel
 * (ADR 0097) carries its own `displayName`, so it resolves through this path with no
 * special-casing — it renders its own live handle like any other author.
 */
import type {Effect} from "effect";
import {Effect as Eff} from "effect";
import type {ProfileIdentityRow} from "../pasaport/Pasaport.ts";

/**
 * The batched author-identity reader this stamp needs — the `Pasaport` method that
 * reads `{username, displayName}` for a set of author ids in one `IN (…)` query. Taken
 * as a narrow function dep (not the whole `Pasaport` service) so the stamp stays
 * unit-testable with a plain stub, mirroring how `stampReactionAggregate` takes the
 * reaction service handle.
 */
export type ReadProfileIdentities = (
	userIds: ReadonlyArray<string>,
) => Effect.Effect<ProfileIdentityRow[]>;

/** The two live-identity fields the stamp adds to a row keyed by `authorId`. */
export interface AuthorIdentityFields {
	readonly authorUsername: string | null;
	readonly authorDisplayName: string | null;
}

/**
 * Run the one batched identity read over `rows`' distinct `authorId`s, then stamp
 * `authorUsername` + `authorDisplayName` onto each row from the live `user_profile`
 * row (or nulls when the author has no profile / no handle yet). One read for the
 * whole batch — never per row. The stamped fields are *added* to the input row
 * shape, so a read that wants live identity must route through here (a path that
 * skips the stamp never produces the fields).
 */
export const stampAuthorIdentity = <R extends {authorId: string}>(
	read: ReadProfileIdentities,
	rows: ReadonlyArray<R>,
): Effect.Effect<Array<R & AuthorIdentityFields>> =>
	Eff.gen(function* () {
		const ids = [...new Set(rows.map((row) => row.authorId).filter((id) => id !== ""))];
		const identities = ids.length === 0 ? [] : yield* read(ids);
		const byId = new Map(identities.map((i) => [i.userId, i]));
		return rows.map((row) => {
			const identity = byId.get(row.authorId);
			return {
				...row,
				authorUsername: identity?.username ?? null,
				authorDisplayName: identity?.displayName ?? null,
			};
		});
	});
