/**
 * Pasaport fate sources — `User` / `Profile` Effect-backed loaders. fate is pure transport
 * (ADR 0016). See `.patterns/fate-effect-sources.md`.
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
	RoleStateView,
	UserView,
} from "./views.ts";

export const userSource = Fate.source(
	UserView,
	{id: "id"},
	{
		// The domain compose joins `isModerator` (#1320) onto the rows in ONE
		// `RelationStore` read — never a per-row probe in this loader.
		byIds: (ids) => getUsersWithModerationByIds(ids),
	},
);

export const profileSource = Fate.source(
	ProfileView,
	{id: "userId"},
	{
		byId: function* (userId) {
			const pasaport = yield* Pasaport;
			// The SAME viewer the root `queries.profile` resolves, so headline counts agree
			// on every fetch path (#1406).
			const sandboxViewer = yield* currentSandboxViewer;
			const row = yield* pasaport.lookupProfileById(userId, {sandboxViewer});
			// `toProfile` stamps the client normalization key `id`; the service row carries
			// only `userId`.
			return row ? toProfile(row) : row;
		},
	},
);

// `Contribution` has no fetch path — rows are synthetic and delivered inline by
// `queries.profile` (ADR 0019). `syntheticSource` registers the entity with ZERO
// capabilities so source-completeness accepts it; see
// `.patterns/fate-effect-sources.md`. The same shape repeats for every synthetic
// source below.
export const contributionSource = Fate.syntheticSource(ContributionView);

// The `account.delete` ack, returned inline by the mutation (ADR 0097).
export const accountDeletionReceiptSource = Fate.syntheticSource(AccountDeletionReceiptView);

// The `user.promote` / `user.vouch` ack, returned inline by the mutation (#1206).
export const promotionReceiptSource = Fate.syntheticSource(PromotionReceiptView);

// Per-viewer, keyed on `CurrentUser` rather than a global entity (#1316).
export const authorshipStandingSource = Fate.syntheticSource(AuthorshipStandingView);

// Produced ONLY past the `requireAdmin` gate (epic #968); a by-id source here would be an
// ungated leak of an account's ban-state.
export const banStateSource = Fate.syntheticSource(BanStateView);

// Produced ONLY past the `requireAdmin` gate (#3522); the derived role IS re-readable via
// the gated `UserAdmin` roster.
export const roleStateSource = Fate.syntheticSource(RoleStateView);

// Produced ONLY past the `requireAdmin` gate (epic #2687); a by-id source here would be an
// ungated leak of an address's delivery-state.
export const emailDeliveryStateSource = Fate.syntheticSource(EmailDeliveryStateView);

// Delivered inline by the `emailDelivery.failing` list resolver, a private admin surface.
export const failingAddressSource = Fate.syntheticSource(FailingAddressView);
