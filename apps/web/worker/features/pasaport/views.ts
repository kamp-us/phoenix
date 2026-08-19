/**
 * Pasaport fate data views — `User`, `Profile`, `Contribution` (ADR 0018; see
 * `.patterns/fate-effect-data-views.md`).
 *
 * `Profile.contributions`'s `orderBy` and the service keyset both derive from
 * `contributionOrdering` (`ordering.ts`), so they can't drift (ADR 0019;
 * `.patterns/fate-connections.md`).
 */
import {FateDataView, type WorkerEntity} from "@kampus/fate-effect";
import type {ViewRow} from "../fate/view-types.ts";
import type {PlatformRole} from "../kunye/moderate.ts";
import {CONTRIBUTION_VIEW_ORDER_BY} from "./ordering.ts";
import type {ContributionRow} from "./Pasaport.ts";
import {type ProfileRow, profileViewFields} from "./profile-fields.ts";
import {type UserFields, userViewFields} from "./user-fields.ts";

// Exported because the `Fate.source` entries surface the row type in their
// declarations (TS2883 portability).
export type UserViewRow = ViewRow<UserFields>;
export type ProfileViewRow = ViewRow<ProfileRow & {id: string}>;
export type ContributionViewRow = ViewRow<ContributionRow>;

// `username` is `null` until the bootstrap step sets it.
// `tier` must be filled from `Kunye.tierOf` (the stored `user.tier` column read
// fresh), NEVER from the `input:false` better-auth session additionalField
// (#1203/#1297). `isModerator` is keyed on the CURRENT user, so it is only ever the
// viewer's OWN mod status, read off the `moderates` relation tuple (ADR 0107 §4).
export class UserView extends FateDataView<UserViewRow>()("User")(userViewFields) {}

// fate has no union type, so the variants' fields are flattened onto one row keyed
// by a `kind` discriminant (ADR 0018).
export class ContributionView extends FateDataView<ContributionViewRow>()("Contribution")({
	kind: true,
	id: true,
	score: true,
	createdAt: true,
	// Carries no reviewer identity (one-way-glass, #1316).
	sandboxed: true,
	bodyExcerpt: true,
	termSlug: true,
	termTitle: true,
	title: true,
	slug: true,
	postId: true,
	postTitle: true,
} satisfies {[K in keyof ContributionViewRow]: true}) {}

// Every view here needs an `id`: it is the client's normalization key (codegen
// hardcodes `getId` to `record.id`), and without it the client throws `Missing 'id'
// on entity record` when normalizing (see `.patterns/fate-data-views.md`). A
// `Profile` is one-to-one with its user, so `id` === `userId`, and `userId` stays
// for callers reading the raw per-type id.
export class ProfileView extends FateDataView<ProfileViewRow>()("Profile")({
	...profileViewFields,
	contributions: FateDataView.list(ContributionView, {orderBy: CONTRIBUTION_VIEW_ORDER_BY}),
}) {}

// NOT a re-resolved entity: the deleting user's `User` row is scrubbed to a
// tombstone, so re-resolving it would leak the half-emptied row (ADR 0097). The
// synthetic `id` is the `account:deleted` literal — no per-user payload to leak.
export type AccountDeletionReceiptViewRow = ViewRow<{id: string; deleted: boolean}>;

export class AccountDeletionReceiptView extends FateDataView<AccountDeletionReceiptViewRow>()(
	"AccountDeletionReceipt",
)({
	id: true,
	deleted: true,
} satisfies {[K in keyof AccountDeletionReceiptViewRow]: true}) {}

// `promoted` = did the tier flip this call; `vouchRecorded` = was a new vouch
// persisted this call (vouch path only — the mod path never records a vouch).
export type PromotionReceiptViewRow = ViewRow<{
	id: string;
	userId: string;
	promoted: boolean;
	vouchRecorded: boolean;
}>;

export class PromotionReceiptView extends FateDataView<PromotionReceiptViewRow>()(
	"PromotionReceipt",
)({
	id: true,
	userId: true,
	promoted: true,
	vouchRecorded: true,
} satisfies {[K in keyof PromotionReceiptViewRow]: true}) {}

// `expiresAt` is epoch-millis (or null = permanent / not-banned) to keep the wire
// scalar plain. Carries ONLY the ban-state — no session, no PII.
export type BanStateViewRow = ViewRow<{
	id: string;
	banned: boolean;
	reason: string | null;
	expiresAt: number | null;
}>;

export class BanStateView extends FateDataView<BanStateViewRow>()("BanState")({
	id: true,
	banned: true,
	reason: true,
	expiresAt: true,
} satisfies {[K in keyof BanStateViewRow]: true}) {}

// `id` === the target address, so `emailDelivery.mark` and `emailDelivery.clear`
// reconcile the SAME entity.
export type EmailDeliveryStateViewRow = ViewRow<{
	id: string;
	failing: boolean;
	reason: string | null;
}>;

export class EmailDeliveryStateView extends FateDataView<EmailDeliveryStateViewRow>()(
	"EmailDeliveryState",
)({
	id: true,
	failing: true,
	reason: true,
} satisfies {[K in keyof EmailDeliveryStateViewRow]: true}) {}

// `userId` is nullable: a send can fail to an address with no account row. `since`
// is epoch-millis to keep the wire scalar plain.
export type FailingAddressViewRow = ViewRow<{
	id: string;
	address: string;
	userId: string | null;
	reason: string | null;
	since: number;
}>;

export class FailingAddressView extends FateDataView<FailingAddressViewRow>()("FailingAddress")({
	id: true,
	address: true,
	userId: true,
	reason: true,
	since: true,
} satisfies {[K in keyof FailingAddressViewRow]: true}) {}

// `role` is `moderator` iff the `moderates` tuple was granted, else `member`
// (ADR 0107). Carries ONLY the role — no session, no PII.
export type RoleStateViewRow = ViewRow<{
	id: string;
	role: PlatformRole;
}>;

export class RoleStateView extends FateDataView<RoleStateViewRow>()("RoleState")({
	id: true,
	role: true,
} satisfies {[K in keyof RoleStateViewRow]: true}) {}

// ONE-WAY-GLASS, ENFORCED IN THE TYPE (#1316 hard AC): the row carries ONLY
// aggregate scalars — `vouchExists` is a bare boolean, NOT who vouched;
// `inReviewCount` a bare count, NOT which items or who is reviewing. Adding any
// reviewer / voter / voucher identity field here breaks the invariant, which is why
// this is a self-scoped view rather than a widening of the divan roster or the
// vouch ledger. The subject is always `CurrentUser`, never an input arg.
export type AuthorshipStandingViewRow = ViewRow<{
	id: string;
	karma: number;
	bar: number;
	vouchExists: boolean;
	inReviewCount: number;
}>;

export class AuthorshipStandingView extends FateDataView<AuthorshipStandingViewRow>()(
	"AuthorshipStanding",
)({
	id: true,
	karma: true,
	bar: true,
	vouchExists: true,
	inReviewCount: true,
} satisfies {[K in keyof AuthorshipStandingViewRow]: true}) {}

export const userDataView = UserView.view;
export const contributionDataView = ContributionView.view;
export const profileDataView = ProfileView.view;
export const accountDeletionReceiptDataView = AccountDeletionReceiptView.view;
export const promotionReceiptDataView = PromotionReceiptView.view;
export const authorshipStandingDataView = AuthorshipStandingView.view;
export const banStateDataView = BanStateView.view;
export const roleStateDataView = RoleStateView.view;
export const emailDeliveryStateDataView = EmailDeliveryStateView.view;
export const failingAddressDataView = FailingAddressView.view;

export type User = WorkerEntity<typeof UserView>;
export type Contribution = WorkerEntity<typeof ContributionView, "createdAt">;
export type Profile = WorkerEntity<typeof ProfileView, never, {contributions?: Contribution[]}>;
export type AccountDeletionReceipt = WorkerEntity<typeof AccountDeletionReceiptView>;
export type PromotionReceipt = WorkerEntity<typeof PromotionReceiptView>;
export type AuthorshipStanding = WorkerEntity<typeof AuthorshipStandingView>;
export type BanStateEntity = WorkerEntity<typeof BanStateView>;
export type RoleStateEntity = WorkerEntity<typeof RoleStateView>;
export type EmailDeliveryStateEntity = WorkerEntity<typeof EmailDeliveryStateView>;
export type FailingAddressEntity = WorkerEntity<typeof FailingAddressView>;
