/**
 * Pasaport wire-entity shapers — `User` (+ re-exported `toContributionRow`).
 *
 * Every `{__typename: "User", …}` literal is built here, once; resolvers and
 * mutations call the shaper instead of hand-restating the literal so adding or
 * renaming a field is a one-line edit and the read/write paths can never drift
 * out of byte-for-byte agreement.
 *
 * `toContributionRow` lives in the service module (`Pasaport.ts`) because the
 * service produces the flattened `ContributionRow`; the shaper layer re-exports
 * it so the call sites (`queries.profile`) reach a stable `features/pasaport`
 * surface.
 *
 * See `.patterns/fate-mutations.md`.
 */

import type {User} from "../fate/views.ts";
import {toContributionRow} from "./Pasaport.ts";

export {toContributionRow};

export interface UserFields {
	id: string;
	email: string;
	name: string | null;
	image: string | null;
	username: string | null;
}

/** Shape resolved user fields into the `User` wire entity. */
export const toUser = (r: UserFields): User => ({
	__typename: "User",
	id: r.id,
	email: r.email,
	name: r.name,
	image: r.image,
	username: r.username,
});
