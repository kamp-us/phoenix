/**
 * Pasaport fate sources — `User` / `Profile` Effect-backed loaders. fate is pure
 * transport (ADR 0016); every handler delegates to a `Pasaport` method, so read
 * logic stays in the domain layer. `Profile` is fetched by `userId` (the root
 * `profile`/`me` resolvers build the full shape inline, so this `byId` exists for
 * relation/by-id callers). See `.patterns/fate-effect-sources.md`.
 */
import {Fate} from "@kampus/fate-effect";
import {Effect} from "effect";
import {isModerator} from "../kunye/moderate.ts";
import {Pasaport} from "./Pasaport.ts";
import {toProfile} from "./shapers.ts";
import {
	AccountDeletionReceiptView,
	AuthorshipStandingView,
	ContributionView,
	ProfileView,
	PromotionReceiptView,
	UserView,
} from "./views.ts";

export const userSource = Fate.source(
	UserView,
	{id: "id"},
	{
		// `isModerator` (#1320) isn't a stored column — it's each user's `(id,
		// "moderates", platform)` membership in the `relation_tuple` store (the same
		// tuple `Moderate.over(platform)` discharges, ADR 0107). The by-id loader joins
		// it per row off `RelationStore` so the field is total for any `User` entity,
		// not just the self `me` path. Moderator standing is an aggregate boolean, not
		// secret (the issue's "expose 'can promote', not a role list"), so reading it
		// for a by-id load is honest, not a leak.
		byIds: function* (ids) {
			const pasaport = yield* Pasaport;
			const rows = yield* pasaport.getUsersByIds(ids);
			return yield* Effect.forEach(rows, (row) =>
				Effect.map(isModerator(row.id), (isMod) => ({...row, isModerator: isMod})),
			);
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

// `AccountDeletionReceipt` has no fetch path — it is the `account.delete` ack,
// returned inline by the mutation and never read by id (ADR 0097). Registered
// with ZERO capabilities so source-completeness accepts the view-reachable result
// type; mirrors `reportReceiptSource`.
export const accountDeletionReceiptSource = Fate.syntheticSource(AccountDeletionReceiptView);

// `PromotionReceipt` has no fetch path — it is the `user.promote` / `user.vouch`
// ack, returned inline by the mutation and never read by id (#1206). Registered with
// ZERO capabilities so source-completeness accepts the view-reachable result type;
// mirrors `accountDeletionReceiptSource`.
export const promotionReceiptSource = Fate.syntheticSource(PromotionReceiptView);

// `AuthorshipStanding` has no fetch path — it is the çaylak-self standing aggregate
// (#1316), delivered inline by the `myAuthorshipStanding` resolver and never read by
// id (it is per-viewer, keyed on `CurrentUser`, not a global entity). Registered with
// ZERO capabilities so source-completeness accepts the view-reachable result type;
// mirrors `promotionReceiptSource`.
export const authorshipStandingSource = Fate.syntheticSource(AuthorshipStandingView);
