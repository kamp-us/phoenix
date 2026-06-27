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
export type UserViewRow = ViewRow<Omit<UserRow, "tier"> & {tier: Tier}>;
export type ProfileViewRow = ViewRow<ProfileRow & {id: string}>;
export type ContributionViewRow = ViewRow<ContributionRow>;

// `username` is `null` until the bootstrap step sets it.
// `tier` is the GLOBAL account-level authorship rank (ADR 0107 §4), exposed on
// the TRUSTED read path: the resolver fills it from `Kunye.tierOf` (the stored
// `user.tier` column read fresh through pasaport), NEVER from the `input:false`
// better-auth session additionalField (#1203/#1297). Always present — the value
// is not secret; the frontend gates rendering of authorship affordances on the
// `phoenix-authorship-loop` flag, not on the field's presence.
export class UserView extends FateDataView<UserViewRow>()("User")({
	id: true,
	email: true,
	name: true,
	image: true,
	username: true,
	tier: true,
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

// The plain kernel `dataView()` values, for cross-feature surfaces (the
// `fate/views.ts` `Root` map + barrel re-exports).
export const userDataView = UserView.view;
export const contributionDataView = ContributionView.view;
export const profileDataView = ProfileView.view;
export const accountDeletionReceiptDataView = AccountDeletionReceiptView.view;
export const promotionReceiptDataView = PromotionReceiptView.view;

export type User = WorkerEntity<typeof UserView>;
export type Contribution = WorkerEntity<typeof ContributionView, "createdAt">;
export type Profile = WorkerEntity<typeof ProfileView, never, {contributions?: Contribution[]}>;
export type AccountDeletionReceipt = WorkerEntity<typeof AccountDeletionReceiptView>;
export type PromotionReceipt = WorkerEntity<typeof PromotionReceiptView>;
