/**
 * Pasaport fate data views — `User`, `Profile`, `Contribution` (ADR 0018; see
 * `.patterns/fate-effect-data-views.md`).
 *
 * `Profile.contributions`'s `orderBy` MUST stay in lockstep with the service's
 * keyset `ORDER BY` (`createdAt desc, id desc`) or the cursors stop round-tripping
 * (ADR 0019; `.patterns/fate-connections.md`).
 */
import {type Entity, FateDataView} from "@kampus/fate-effect";
import type {ViewRow} from "../fate/view-types.ts";
import type {ContributionRow, ProfileRow, UserRow} from "./Pasaport.ts";

// Exported because the `Fate.source` entries surface the row type in their
// declarations (TS2883 portability). The `Profile` view row adds the client
// normalization key `id` (=== `userId`, stamped by the resolver).
export type UserViewRow = ViewRow<UserRow>;
export type ProfileViewRow = ViewRow<ProfileRow & {id: string}>;
export type ContributionViewRow = ViewRow<ContributionRow>;

// `username` is `null` until the bootstrap step sets it.
export class UserView extends FateDataView<UserViewRow>()("User")({
	id: true,
	email: true,
	name: true,
	image: true,
	username: true,
}) {}

// The **discriminant** view for the profile contributions feed: fate has no
// union type, so the three variants' fields are flattened onto one row keyed by
// a `kind` discriminant (ADR 0018; flattened by `shapers.toContributionRow`).
// Variant fields are nullable, populated per `kind`: definition →
// bodyExcerpt/termSlug/termTitle, post → title/slug/bodyExcerpt, comment →
// bodyExcerpt/postId/postTitle.
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
}) {}

// `id` is the client's normalization key (codegen hardcodes `getId` to
// `record.id`); a `Profile` is one-to-one with its user, so `id` === `userId`,
// stamped by `queries.profile`. Without it the client throws `Missing 'id' on
// entity record` when normalizing (see `.patterns/fate-data-views.md`). `userId`
// stays for callers reading the raw per-type id (the source `byId` is keyed by it).
// `contributions.orderBy` MUST equal the service keyset `ORDER BY`
// (`createdAt desc, id desc`) or cursors skip/dupe (ADR 0019).
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
	contributions: FateDataView.list(ContributionView, {
		orderBy: [{createdAt: "desc"}, {id: "desc"}],
	}),
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

// The plain kernel `dataView()` values, for cross-feature surfaces (the
// `fate/views.ts` `Root` map + barrel re-exports).
export const userDataView = UserView.view;
export const contributionDataView = ContributionView.view;
export const profileDataView = ProfileView.view;
export const accountDeletionReceiptDataView = AccountDeletionReceiptView.view;

// The `Entity<>` second arg restates relations/`Date` fields that fate's
// wire-facing derivation widens/narrows away — full rationale in `sozluk/views.ts`.
export type User = Entity<typeof UserView>;
export type Contribution = Entity<typeof ContributionView, {createdAt: Date}>;
export type Profile = Entity<typeof ProfileView, {contributions?: Contribution[]}>;
export type AccountDeletionReceipt = Entity<typeof AccountDeletionReceiptView>;
