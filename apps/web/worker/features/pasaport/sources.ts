/**
 * Pasaport fate sources — `User` / `Profile` Effect-backed loaders.
 *
 * fate is pure transport (ADR 0016): it never queries D1. Every handler
 * delegates to a `Pasaport` method, so all read logic stays in the domain
 * layer.
 *
 * `Profile` is fetched by its `userId` (the immutable per-user id; `username`
 * may be null until bootstrap). The root `profile(username)` / `me` resolvers
 * are custom queries that build the full `Profile` shape inline, so this `byId`
 * exists for relation/by-id callers; it re-aggregates the live counts.
 *
 * The loader contract is in the types (`.patterns/fate-effect-sources.md`):
 * reads are silent (absence = `null`/fewer rows), `E = never` — the
 * `DrizzleError` channel is infrastructure, so it dies (`orDieDrizzle`)
 * instead of becoming a wire value.
 */
import {type AnyFateSourceEntry, Fate} from "@phoenix/fate-effect";
import {orDieDrizzle} from "../../db/Drizzle.ts";
import {Pasaport} from "./Pasaport.ts";
import {ContributionView, ProfileView, UserView} from "./views.ts";

export const userSource = Fate.source(
	UserView,
	{id: "id"},
	{
		byId: function* (id) {
			const pasaport = yield* Pasaport;
			return yield* pasaport.getUserById(id).pipe(orDieDrizzle);
		},
		byIds: function* (ids) {
			const pasaport = yield* Pasaport;
			return yield* pasaport.getUsersByIds(ids).pipe(orDieDrizzle);
		},
	},
);

export const profileSource = Fate.source(
	ProfileView,
	{id: "userId"},
	{
		byId: function* (userId) {
			const pasaport = yield* Pasaport;
			const row = yield* pasaport.lookupProfileById(userId).pipe(orDieDrizzle);
			// Stamp the client normalization key `id` (=== `userId`); the service row
			// carries only `userId`.
			return row ? {...row, id: row.userId} : row;
		},
	},
);

/**
 * `Contribution` has no fetch path of its own — the rows are synthetic
 * (flattened from definitions/posts/comments by `queries.profile`'s shaper) and
 * the `Profile.contributions` connection is delivered inline by that custom
 * resolver (ADR 0019), so no byId/byIds/connection handler is implementable or
 * needed. `Fate.source` makes a loader-less source unrepresentable by design,
 * so this entry is the hand-built type-erased form (`AnyFateSourceEntry`,
 * empty handlers): it exists because the entity is view-reachable
 * (`Profile.contributions` nests `ContributionView`) and the fate-effect
 * server's source-completeness validation requires every reachable entity to
 * be registered; any actual capability call still fails loudly, exactly as the
 * bridge's capability-less executor did.
 */
export const contributionSource: AnyFateSourceEntry = {
	typeName: "Contribution",
	definition: {id: "id", view: ContributionView.view},
	handlers: {},
};
