/**
 * Pasaport fate sources — `User` / `Profile` Effect-backed loaders. fate is pure
 * transport (ADR 0016); every handler delegates to a `Pasaport` method, so read
 * logic stays in the domain layer. `Profile` is fetched by `userId` (the root
 * `profile`/`me` resolvers build the full shape inline, so this `byId` exists for
 * relation/by-id callers). See `.patterns/fate-effect-sources.md`.
 */
import {Fate} from "@kampus/fate-effect";
import {currentSandboxViewer} from "../kunye/sandbox.ts";
import {Pasaport} from "./Pasaport.ts";
import {toProfile} from "./shapers.ts";
import {getUsersWithModerationByIds} from "./trusted-user.ts";
import {
	AccountDeletionReceiptView,
	AuthorshipStandingView,
	BanStateView,
	ContributionView,
	EmailDeliveryStateView,
	FailingAddressView,
	ProfileView,
	PromotionReceiptView,
	UserView,
} from "./views.ts";

export const userSource = Fate.source(
	UserView,
	{id: "id"},
	{
		// Pure transport (ADR 0016): delegate to the domain compose, which joins the
		// `isModerator` (#1320) `(id, "moderates", platform)` membership onto the user
		// rows in ONE `RelationStore` read — never a per-row probe in this loader. The
		// moderator signal is an aggregate boolean, not secret, so reading it for a
		// by-id load is honest, not a leak.
		byIds: (ids) => getUsersWithModerationByIds(ids),
	},
);

export const profileSource = Fate.source(
	ProfileView,
	{id: "userId"},
	{
		byId: function* (userId) {
			const pasaport = yield* Pasaport;
			// Thread the SAME request sandbox viewer the root `queries.profile` resolves,
			// so the by-id relation path computes identical sandbox/draft-aware headline
			// counts — counts agree on every fetch path (#1406).
			const sandboxViewer = yield* currentSandboxViewer;
			const row = yield* pasaport.lookupProfileById(userId, {sandboxViewer});
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

// `BanState` has no by-id fetch path — it is produced ONLY past the `requireAdmin`
// gate (epic #968), by the `user.banState` admin read and the `user.banUser` /
// `user.unbanUser` mutation acks, never a public by-id load (a by-id source would be
// an ungated leak of an account's ban-state). Registered with ZERO capabilities so
// source-completeness accepts the view-reachable result type; mirrors
// `promotionReceiptSource`.
export const banStateSource = Fate.syntheticSource(BanStateView);

// `EmailDeliveryState` has no by-id fetch path — it is produced ONLY past the
// `requireAdmin` gate (epic #2687), by the `emailDelivery.mark` / `emailDelivery.clear`
// mutation acks, never a public by-id load (a by-id source would be an ungated leak of an
// address's delivery-state). Registered with ZERO capabilities so source-completeness
// accepts the view-reachable result type; mirrors `banStateSource`.
export const emailDeliveryStateSource = Fate.syntheticSource(EmailDeliveryStateView);

// `FailingAddress` has no by-id fetch path — the roll-up rows are delivered INLINE by the
// `emailDelivery.failing` list resolver (a private admin surface), never read by id.
// Registered with ZERO capabilities so source-completeness accepts the view-reachable
// result type; mirrors divan's list-item synthetic sources.
export const failingAddressSource = Fate.syntheticSource(FailingAddressView);
