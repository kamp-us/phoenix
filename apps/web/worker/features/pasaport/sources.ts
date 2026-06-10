/**
 * Pasaport fate source executors — `User` / `Profile` Effect-backed reads.
 *
 * fate is pure transport (ADR 0016): it never queries D1. Every source executor
 * delegates to an Effect service method through {@link fateSource}, so all read
 * logic stays in the domain layer.
 *
 * `Profile` is fetched by its `userId` (the immutable per-user id; `username`
 * may be null until bootstrap). The root `profile(username)` / `me` resolvers
 * are custom queries that build the full `Profile` shape inline, so this `byId`
 * exists for relation/by-id callers; it re-aggregates the live counts.
 *
 * See `.patterns/fate-sources.md`.
 */
import {
	type AnyDataView,
	type AnySourceDefinition,
	fateSource,
	type SourceExecutor,
} from "../fate/effect.ts";
import {Pasaport, type ProfileRow, type UserRow} from "./Pasaport.ts";
import {contributionDataView, profileDataView, userDataView} from "./views.ts";

type UserViewRow = {[K in keyof UserRow]: UserRow[K]};
// The `Profile` view row adds the client normalization key `id` (=== `userId`)
// on top of the service `ProfileRow` — mirrors `views.ts`.
type ProfileViewRow = {[K in keyof ProfileRow]: ProfileRow[K]} & {id: string};

export const userExecutor: SourceExecutor = fateSource<UserViewRow>({
	byId: function* (id) {
		const pasaport = yield* Pasaport;
		return yield* pasaport.getUserById(id);
	},
	byIds: function* (ids) {
		const pasaport = yield* Pasaport;
		return yield* pasaport.getUsersByIds(ids);
	},
});

export const profileExecutor: SourceExecutor = fateSource<ProfileViewRow>({
	byId: function* (userId) {
		const pasaport = yield* Pasaport;
		const row = yield* pasaport.lookupProfileById(userId);
		// Stamp the client normalization key `id` (=== `userId`); the service row
		// carries only `userId`.
		return row ? {...row, id: row.userId} : row;
	},
});

/**
 * `Contribution` has no fetch path of its own — the rows are synthetic
 * (flattened from definitions/posts/comments by `queries.profile`'s shaper) and
 * the `Profile.contributions` connection is delivered inline by that custom
 * resolver (ADR 0019), so no byId/byIds/connection executor is implementable or
 * needed. The capability-less executor exists because the entity is
 * view-reachable (`Profile.contributions` nests `contributionDataView`) and the
 * fate-effect server's source-completeness validation requires every reachable
 * entity to be registered; any actual capability call would fail loudly,
 * exactly as the previously-unregistered entity did.
 */
export const contributionExecutor: SourceExecutor = {};

export const userSource: AnySourceDefinition = {id: "id", view: userDataView as AnyDataView};
export const profileSource: AnySourceDefinition = {
	id: "userId",
	view: profileDataView as AnyDataView,
};
export const contributionSource: AnySourceDefinition = {
	id: "id",
	view: contributionDataView as AnyDataView,
};
