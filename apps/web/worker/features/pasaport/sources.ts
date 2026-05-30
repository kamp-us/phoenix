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
import type {SourceDefinition} from "@nkzw/fate/server";
import {fateSource, type SourceExecutor} from "../fate/effect.ts";
import {Pasaport, type ProfileRow, type UserRow} from "./Pasaport.ts";
import {profileDataView, userDataView} from "./views.ts";

type AnySourceDefinition = SourceDefinition<Record<string, unknown>, unknown>;
type AnyDataView = AnySourceDefinition["view"];

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

export const userSource: AnySourceDefinition = {id: "id", view: userDataView as AnyDataView};
export const profileSource: AnySourceDefinition = {
	id: "userId",
	view: profileDataView as AnyDataView,
};
