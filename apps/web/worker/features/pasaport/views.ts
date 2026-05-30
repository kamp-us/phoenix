/**
 * Pasaport fate data views — `User`, `Profile`, `Contribution`.
 *
 * Data views are the schema (ADR 0018): each `dataView` declares an entity
 * type's fields; the exported `Entity<>` types are the client's types (codegen,
 * no schema artifact).
 *
 * `Profile.contributions` is a `list(contributionDataView, {orderBy})` whose
 * `orderBy` is kept in lockstep with the service's keyset `ORDER BY`
 * (`createdAt desc, id desc`) so the keyset cursors round-trip (ADR 0019; see
 * `.patterns/fate-connections.md`).
 *
 * See `.patterns/fate-data-views.md`.
 */
import type {SourceDefinition} from "@nkzw/fate/server";
import {dataView, list} from "@nkzw/fate/server";
import type {ContributionRow, ProfileRow, UserRow} from "./Pasaport.ts";

type ViewRow<Row> = {[K in keyof Row]: Row[K]};

type DataViewOf<Item extends Record<string, unknown>> = SourceDefinition<Item>["view"];

type EntityOf<Row, Fields, Name extends string> = {
	[K in keyof Fields as Fields[K] extends true ? K : never]: K extends keyof Row ? Row[K] : never;
} & {__typename: Name};

type UserViewRow = ViewRow<UserRow>;
// The `Profile` view row adds the client normalization key `id` (=== `userId`,
// stamped by the resolver) on top of the service `ProfileRow`.
type ProfileViewRow = ViewRow<ProfileRow> & {id: string};
type ContributionViewRow = ViewRow<ContributionRow>;

const userFields = {
	id: true,
	email: true,
	name: true,
	image: true,
	username: true,
} as const;

export const userDataView: DataViewOf<UserViewRow> = dataView<UserViewRow>("User")(userFields);

export type User = EntityOf<UserViewRow, typeof userFields, "User">;

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
 * (`Pasaport.toContributionRow`); the profile page reads `kind` and renders the
 * matching row.
 */
const contributionFields = {
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
} as const;

export const contributionDataView: DataViewOf<ContributionViewRow> =
	dataView<ContributionViewRow>("Contribution")(contributionFields);

/**
 * `Profile` — a public user profile plus its contributions feed.
 *
 * Carries identity (`username`/`displayName`/`image`) and the live-aggregated
 * counters (`totalKarma`, `definitionCount`, `postCount`, `commentCount`).
 * `userId` is the raw per-type id (no global id — ADR 0018). Identity fields are
 * flat scalars on the profile; the SPA reads them directly off it.
 *
 * `contributions` is the nested connection — a `list(contributionDataView,
 * {orderBy})` whose `orderBy` MUST equal the service's keyset `ORDER BY`
 * (`createdAt desc, id desc`) so the cursors round-trip without skips/dupes
 * (ADR 0019). `id` is the explicit final tiebreaker.
 */
const profileFields = {
	// `id` is the client's normalization key (the codegen hardcodes `getId` to
	// `record.id`). A `Profile` is one-to-one with its user, so `id` === `userId`
	// (stamped by `queries.profile`). `userId` stays for callers that read the
	// raw per-type id directly (the source `byId`
	// is keyed by it). Without an `id` the client throws `Missing 'id' on entity
	// record` when normalizing the profile (same class of constraint as `Tag`
	// — see `.patterns/fate-data-views.md`).
	id: true,
	userId: true,
	username: true,
	displayName: true,
	image: true,
	totalKarma: true,
	definitionCount: true,
	postCount: true,
	commentCount: true,
} as const;

export const profileDataView: DataViewOf<ProfileViewRow> = dataView<ProfileViewRow>("Profile")({
	...profileFields,
	contributions: list(contributionDataView, {
		orderBy: [{createdAt: "desc"}, {id: "desc"}],
	}),
});

export type Contribution = EntityOf<ContributionViewRow, typeof contributionFields, "Contribution">;
// `contributions` is an optional relation intersected on; `Contribution` is
// `id`-keyed (a global ULID), so it normalizes cleanly unlike `Tag`. See
// `.patterns/fate-data-views.md`.
export type Profile = EntityOf<ProfileViewRow, typeof profileFields, "Profile"> & {
	contributions?: Contribution[];
};
