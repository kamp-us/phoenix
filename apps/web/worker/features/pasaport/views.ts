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
import type {Tier} from "../kunye/standing.ts";
import {CONTRIBUTION_VIEW_ORDER_BY} from "./ordering.ts";
import type {ContributionRow, ProfileRow, UserRow} from "./Pasaport.ts";

// Exported because the `Fate.source` entries surface the row type in their
// declarations (TS2883 portability). The `Profile` view row adds the client
// normalization key `id` (=== `userId`, stamped by the resolver).
//
// `tier` is widened from the stored `StoredTier` (`çaylak | yazar`) to the
// read-time `Tier` (`visitor | çaylak | yazar`): the `me` resolver reads it via
// `Kunye.tierOf`, which ranks a row-missing principal as `visitor`, so the wire
// value spans the full ladder even though the column itself never stores it.
//
// `isModerator` (#1320) is the SELF moderator signal — not a stored column either:
// the resolver reads it from the `moderates` `relation_tuple` (the same tuple
// `Moderate.over(platform)` discharges, ADR 0107 §4), so it joins onto the wire row
// here, never on `UserRow`.
export type UserViewRow = ViewRow<Omit<UserRow, "tier"> & {tier: Tier; isModerator: boolean}>;
export type ProfileViewRow = ViewRow<ProfileRow & {id: string}>;
export type ContributionViewRow = ViewRow<ContributionRow>;

// `username` is `null` until the bootstrap step sets it.
// `tier` is the GLOBAL account-level authorship rank (ADR 0107 §4), exposed on
// the TRUSTED read path: the resolver fills it from `Kunye.tierOf` (the stored
// `user.tier` column read fresh through pasaport), NEVER from the `input:false`
// better-auth session additionalField (#1203/#1297). Always present — the value
// is not secret; the frontend gates rendering of authorship affordances on the
// `phoenix-authorship-loop` flag, not on the field's presence.
//
// `isModerator` is the SELF moderator signal (#1320): the resolver reads it
// server-side off the `moderates` `relation_tuple` (`kunye/moderate.ts`'s
// `isModerator`, the same tuple `Moderate.over(platform)` checks — never a
// retired `user.role` column, ADR 0107), keyed on the CURRENT user, so it is only
// ever the viewer's OWN mod status. Like `tier` it is always present (the divan
// "yazar yap" affordance is gated frontend-side); a dual-role yazar+moderator reads
// `tier: "yazar"` + `isModerator: true`, which `tier` alone cannot express.
export class UserView extends FateDataView<UserViewRow>()("User")({
	id: true,
	email: true,
	name: true,
	image: true,
	username: true,
	tier: true,
	isModerator: true,
}) {}

// The **discriminant** view for the profile contributions feed: fate has no
// union type, so the variants' fields are flattened onto one row keyed by a
// `kind` discriminant (ADR 0018; flattened by `shapers.toContributionRow`).
// The field map IS the keys of `ContributionRow`, which derives from the
// `ContributionVariants` manifest in `Pasaport.ts` — `ContributionViewRow` is
// `ViewRow<ContributionRow>`, so a field added there (or dropped here) is a
// compile error, never a silent flatten drift.
export class ContributionView extends FateDataView<ContributionViewRow>()("Contribution")({
	kind: true,
	id: true,
	score: true,
	createdAt: true,
	// The per-item review-state flag (#1316): `true` for a still-sandboxed item, so
	// #1291 can badge "incelemede". Carries no reviewer identity (one-way-glass).
	sandboxed: true,
	bodyExcerpt: true,
	termSlug: true,
	termTitle: true,
	title: true,
	slug: true,
	postId: true,
	postTitle: true,
} satisfies {[K in keyof ContributionViewRow]: true}) {}

// `id` is the client's normalization key (codegen hardcodes `getId` to
// `record.id`); a `Profile` is one-to-one with its user, so `id` === `userId`,
// stamped by `queries.profile`. Without it the client throws `Missing 'id' on
// entity record` when normalizing (see `.patterns/fate-data-views.md`). `userId`
// stays for callers reading the raw per-type id (the source `byId` is keyed by it).
// `contributions.orderBy` derives from `contributionOrdering` (ADR 0019).
export class ProfileView extends FateDataView<ProfileViewRow>()("Profile")({
	id: true,
	userId: true,
	username: true,
	displayName: true,
	image: true,
	totalKarma: true,
	definitionCount: true,
	postCount: true,
	commentCount: true,
	contributions: FateDataView.list(ContributionView, {orderBy: CONTRIBUTION_VIEW_ORDER_BY}),
}) {}

// The `account.delete` acknowledgement (ADR 0097) — NOT a re-resolved entity. The
// deleting user's `User` row is scrubbed to a tombstone, so re-resolving it would
// leak the half-emptied row; the mutation returns a small typed ack instead. The
// synthetic `id` is the `account:deleted` literal — one receipt shape, no per-user
// payload to leak. Mirrors `ReportReceipt`; see `.patterns/fate-effect-data-views.md`.
export type AccountDeletionReceiptViewRow = ViewRow<{id: string; deleted: boolean}>;

export class AccountDeletionReceiptView extends FateDataView<AccountDeletionReceiptViewRow>()(
	"AccountDeletionReceipt",
)({
	id: true,
	deleted: true,
}) {}

// The çaylak→yazar promotion acknowledgement (#1206) — NOT a re-resolved entity
// (the promotion's effects, the flipped tier + the swept backlog, are read through
// the existing `Profile` / content views). The mutation returns a small typed ack:
// `promoted` = did the tier flip this call; `vouchRecorded` = was a new vouch
// persisted this call (vouch path only — the mod path never records a vouch). The
// `id` carries the target so two targets resolve as distinct receipts. Mirrors
// `AccountDeletionReceipt`; see `.patterns/fate-effect-data-views.md`.
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
}) {}

// The çaylak-SELF authorship-standing aggregate (#1316, epic #1202) — the
// "yazarlığa giden yol" read the #1291 status block consumes about ITSELF. The
// subject is always the authenticated çaylak (the `myAuthorshipStanding` resolver
// keys it on `CurrentUser`, never an input arg), so it can only ever describe the
// reader's own progress.
//
// ONE-WAY-GLASS, ENFORCED IN THE TYPE (#1316 hard AC): the row carries ONLY
// aggregate scalars — `karma`/`bar` (numbers), `vouchExists` (a bare boolean, NOT
// who vouched), `inReviewCount` (a bare count, NOT which items or who is reviewing).
// There is deliberately NO reviewer / voter / voucher identity field, so a leak is
// structurally unrepresentable, not merely unsent — the reason this is a NEW
// self-scoped view and not a widening of the identity-carrying divan roster / vouch
// ledger. `id` === the user id (the client normalization key).
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
}) {}

// The plain kernel `dataView()` values, for cross-feature surfaces (the
// `fate/views.ts` `Root` map + barrel re-exports).
export const userDataView = UserView.view;
export const contributionDataView = ContributionView.view;
export const profileDataView = ProfileView.view;
export const accountDeletionReceiptDataView = AccountDeletionReceiptView.view;
export const promotionReceiptDataView = PromotionReceiptView.view;
export const authorshipStandingDataView = AuthorshipStandingView.view;

export type User = WorkerEntity<typeof UserView>;
export type Contribution = WorkerEntity<typeof ContributionView, "createdAt">;
export type Profile = WorkerEntity<typeof ProfileView, never, {contributions?: Contribution[]}>;
export type AccountDeletionReceipt = WorkerEntity<typeof AccountDeletionReceiptView>;
export type PromotionReceipt = WorkerEntity<typeof PromotionReceiptView>;
export type AuthorshipStanding = WorkerEntity<typeof AuthorshipStandingView>;
