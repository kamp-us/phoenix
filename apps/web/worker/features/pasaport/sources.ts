/**
 * Pasaport fate sources — `User` / `Profile` Effect-backed loaders. fate is pure
 * transport (ADR 0016); every handler delegates to a `Pasaport` method, so read
 * logic stays in the domain layer. `Profile` is fetched by `userId` (the root
 * `profile`/`me` resolvers build the full shape inline, so this `byId` exists for
 * relation/by-id callers). See `.patterns/fate-effect-sources.md`.
 */
import {Fate} from "@phoenix/fate-effect";
import {Pasaport} from "./Pasaport.ts";
import {toProfile} from "./shapers.ts";
import {ContributionView, ProfileView, UserView} from "./views.ts";

export const userSource = Fate.source(
	UserView,
	{id: "id"},
	{
		byId: function* (id) {
			const pasaport = yield* Pasaport;
			return yield* pasaport.getUserById(id);
		},
		byIds: function* (ids) {
			const pasaport = yield* Pasaport;
			return yield* pasaport.getUsersByIds(ids);
		},
	},
);

export const profileSource = Fate.source(
	ProfileView,
	{id: "userId"},
	{
		byId: function* (userId) {
			const pasaport = yield* Pasaport;
			const row = yield* pasaport.lookupProfileById(userId);
			// `toProfile` stamps the client normalization key `id` (=== `userId`);
			// the service row carries only `userId`.
			return row ? toProfile(row) : row;
		},
	},
);

// `Contribution` has no fetch path — rows are synthetic and the connection is
// delivered inline by `queries.profile` (ADR 0019). `syntheticSource` registers
// the entity so source-completeness validation accepts it (it's view-reachable
// via `Profile.contributions`) with ZERO capabilities; any capability call fails
// loudly (`.patterns/fate-effect-sources.md`, the escape hatch).
export const contributionSource = Fate.syntheticSource(ContributionView);
