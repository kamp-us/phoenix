/**
 * `stampAuthorIdentity` — stamps the live `{username, displayName}` onto denormalized
 * author surfaces so they render the author's CURRENT handle, not the write-time
 * `authorName` snapshot (#2139). ONE batched read for the whole page, never per row.
 *
 * A row whose author has no profile (or no handle yet) is stamped with nulls, and the
 * client's `actorLabel` degrades to `@username` → the fallback noun. The deletion
 * `@[silinen]` sentinel (ADR 0097) carries its own `displayName`, so it needs no
 * special-casing here.
 */
import type {Effect} from "effect";
import {Effect as Eff} from "effect";
import type {ProfileIdentityRow} from "../pasaport/Pasaport.ts";

/**
 * Taken as a narrow function dep, not the whole `Pasaport` service, so the stamp stays
 * unit-testable with a plain stub.
 */
export type ReadProfileIdentities = (
	userIds: ReadonlyArray<string>,
) => Effect.Effect<ProfileIdentityRow[]>;

export interface AuthorIdentityFields {
	readonly authorUsername: string | null;
	readonly authorDisplayName: string | null;
}

/**
 * The stamped fields are *added* to the input row shape, so a path that skips the stamp
 * never produces them.
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
