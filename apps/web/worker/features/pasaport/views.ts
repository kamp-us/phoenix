/**
 * Pasaport fate data views — `User`, `Profile`, `Contribution`.
 *
 * Data views are the schema (ADR 0018): each view is a `FateDataView` class
 * whose static `view` IS the kernel `dataView()` output and whose `Entity<>`
 * derivation is the client's type (codegen, no schema artifact).
 *
 * `Profile.contributions` is a `FateDataView.list(ContributionView, {orderBy})`
 * whose `orderBy` is kept in lockstep with the service's keyset `ORDER BY`
 * (`createdAt desc, id desc`) so the keyset cursors round-trip (ADR 0019; see
 * `.patterns/fate-connections.md`).
 *
 * See `.patterns/fate-effect-data-views.md`.
 */
import {type Entity, FateDataView} from "@phoenix/fate-effect";
import type {ViewRow} from "../fate/view-types.ts";
import type {ContributionRow, ProfileRow, UserRow} from "./Pasaport.ts";

/**
 * The view row types — mapped restatements of the service rows
 * (`Record<string, unknown>`-assignable, which the plain row interfaces are
 * not). Exported because the `Fate.source` entries over these views surface
 * the row type in their declarations (`fate/sources.ts` — TS2883 portability).
 * The `Profile` view row adds the client normalization key `id` (=== `userId`,
 * stamped by the resolver) on top of the service `ProfileRow`.
 */
export type UserViewRow = ViewRow<UserRow>;
export type ProfileViewRow = ViewRow<ProfileRow & {id: string}>;
export type ContributionViewRow = ViewRow<ContributionRow>;

/**
 * `User` — the canonical identity row (`me`'s shape and the author relation
 * everywhere). `username` is `null` until the bootstrap step sets it.
 */
export class UserView extends FateDataView<UserViewRow>()("User")({
	id: true,
	email: true,
	name: true,
	image: true,
	username: true,
}) {}

/**
 * `Contribution` — the **discriminant** view for the profile contributions feed
 * (ADR 0018: fate has no union type, so a heterogeneous feed is one view with a
 * `kind` discriminant the profile page switches on). `kind` is `"definition" |
 * "post" | "comment"`; the common fields (`id`, `score`, `createdAt`) are always
 * present, and the variant fields are nullable, populated per `kind`:
 *   - definition → `bodyExcerpt`, `termSlug`, `termTitle`
 *   - post       → `title`, `slug`, `bodyExcerpt`
 *   - comment    → `bodyExcerpt`, `postId`, `postTitle`
 *
 * The three variants' fields are flattened onto one row
 * (`shapers.toContributionRow`); the profile page reads `kind` and renders the
 * matching row.
 */
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

/**
 * `Profile` — a public user profile plus its contributions feed.
 *
 * Carries identity (`username`/`displayName`/`image`) and the live-aggregated
 * counters (`totalKarma`, `definitionCount`, `postCount`, `commentCount`).
 * `userId` is the raw per-type id (no global id — ADR 0018). Identity fields are
 * flat scalars on the profile; the SPA reads them directly off it.
 *
 * `id` is the client's normalization key (the codegen hardcodes `getId` to
 * `record.id`). A `Profile` is one-to-one with its user, so `id` === `userId`
 * (stamped by `queries.profile`). `userId` stays for callers that read the raw
 * per-type id directly (the source `byId` is keyed by it). Without an `id` the
 * client throws `Missing 'id' on entity record` when normalizing the profile
 * (same class of constraint as `Tag` — see `.patterns/fate-data-views.md`).
 *
 * `contributions` is the nested connection — its `orderBy` MUST equal the
 * service's keyset `ORDER BY` (`createdAt desc, id desc`) so the cursors
 * round-trip without skips/dupes (ADR 0019). `id` is the explicit final
 * tiebreaker.
 */
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

/**
 * The kernel views, for the cross-feature surfaces that want fate's plain
 * `dataView()` value (the `fate/views.ts` `Root` map + barrel re-exports, the
 * capability-less `Contribution` source entry in `sources.ts`).
 */
export const userDataView = UserView.view;
export const contributionDataView = ContributionView.view;
export const profileDataView = ProfileView.view;

/*
 * The `Replacements` second parameter restates two things fate's wire-facing
 * `Entity<>` derivation widens/narrows away (see `sozluk/views.ts`):
 *
 *   - list relations (`contributions`) — kernel `list()` widens the child
 *     field map, the same reason fate's own docs use `Replacements`;
 *   - timestamp fields — fate types `Date` row fields as `string` (the
 *     JSON-serialized wire shape), but these worker-side entity values carry
 *     live `Date` objects until fate serializes the response
 *     (`Contribution.createdAt`).
 */
export type User = Entity<typeof UserView>;
export type Contribution = Entity<typeof ContributionView, {createdAt: Date}>;
// `contributions` is an optional relation; `Contribution` is `id`-keyed (a
// global ULID), so it normalizes cleanly unlike `Tag`. See
// `.patterns/fate-data-views.md`.
export type Profile = Entity<typeof ProfileView, {contributions?: Contribution[]}>;
