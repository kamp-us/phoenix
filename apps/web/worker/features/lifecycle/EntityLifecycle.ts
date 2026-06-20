/**
 * The uniform removal substrate's domain model (ADR 0096): a deletable entity's
 * lifecycle as a closed type, not a nullable-flag soup.
 *
 * `EntityLifecycle = Live | Removed({removedAt, removedBy, reason})` is the
 * in-memory **projection** of three persisted columns (`removed_at`,
 * `removed_by`, `removed_reason`) carried on every content table. Services branch
 * on the type via {@link EntityLifecycle.$match} / {@link isRemoved}; they never
 * read the raw columns directly. `Removed` is uninhabitable without its audit
 * triad, so "removed but we don't know by whom/why" is unrepresentable; `restore`
 * is defined only on `Removed`, so restoring a `Live` entity does not typecheck.
 *
 * `RemovalReason` handling is `Match.tagsExhaustive` (effect-smol
 * `packages/effect/src/Match.ts:1095` — a missing case is a compile error), so a
 * fourth reason later forces every call site to address it. ADR 0097 passes
 * `Anonymized`, ADR 0098 passes `Moderated({reportId})`; both build on this.
 */
import * as Data from "effect/Data";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";

/**
 * Why a piece of content was removed — the audit's "why". A `Schema.Union` of
 * tagged structs so it round-trips through the `removed_reason` text column as
 * JSON (`{_tag, …payload}`), carrying e.g. the originating `reportId` for a
 * moderator action. The three members are the three forcing functions of ADR
 * 0096: author self-delete, account anonymization (0097), moderation (0098).
 */
export class AuthorDeletion extends Schema.Class<AuthorDeletion>("lifecycle/AuthorDeletion")({
	_tag: Schema.tag("AuthorDeletion"),
}) {}

export class Anonymized extends Schema.Class<Anonymized>("lifecycle/Anonymized")({
	_tag: Schema.tag("Anonymized"),
}) {}

export class Moderated extends Schema.Class<Moderated>("lifecycle/Moderated")({
	_tag: Schema.tag("Moderated"),
	reportId: Schema.String,
}) {}

export const RemovalReason = Schema.Union([AuthorDeletion, Anonymized, Moderated]);
export type RemovalReason = typeof RemovalReason.Type;

/**
 * The persisted-form codec for the `removed_reason` column: the union encoded as
 * a JSON string. `decodeReason`/`encodeReason` are the only seam between the
 * column and the domain reason; the column is never parsed ad-hoc elsewhere.
 */
const ReasonFromJson = Schema.fromJsonString(RemovalReason);
export const decodeReason = Schema.decodeUnknownSync(ReasonFromJson);
export const encodeReason = Schema.encodeSync(ReasonFromJson);

/**
 * The lifecycle state of a deletable entity. `Removed` carries the full audit
 * triad; there is no `Removed` without `removedAt` + `removedBy` + `reason`.
 */
export type EntityLifecycle = Data.TaggedEnum<{
	// biome-ignore lint/complexity/noBannedTypes: Data.taggedEnum needs the literal `{}` for a payload-less member; `Record<string, never>` makes `Live()` demand an arg.
	Live: {};
	Removed: {
		readonly removedAt: Date;
		readonly removedBy: string;
		readonly reason: RemovalReason;
	};
}>;

export const EntityLifecycle = Data.taggedEnum<EntityLifecycle>();
export const {Live, Removed, $is, $match} = EntityLifecycle;

export type Removed = Extract<EntityLifecycle, {readonly _tag: "Removed"}>;

export const isRemoved = $is("Removed");
export const isLive = $is("Live");

/**
 * The three persisted columns, exactly as they sit on a content row. `removedAt`
 * null ⇒ the entity is `Live`. This is the only shape the projection reads.
 */
export interface RemovalColumns {
	readonly removedAt: Date | null;
	readonly removedBy: string | null;
	readonly removedReason: string | null;
}

/**
 * Reconstitute the lifecycle union from a row's three raw columns — the single
 * projection seam ADR 0096 §2 mandates (services call this, never branch on the
 * columns). A row with `removedAt` set but a missing `removedBy`/`removedReason`
 * is a corrupt half-removal the domain can't represent; we surface it loudly
 * rather than silently projecting a `Removed` with a fabricated audit.
 */
export const fromColumns = (cols: RemovalColumns): EntityLifecycle => {
	if (cols.removedAt === null) return Live();
	if (cols.removedBy === null || cols.removedReason === null) {
		throw new Error(
			"lifecycle: removed_at set without removed_by/removed_reason — corrupt half-removal",
		);
	}
	return Removed({
		removedAt: cols.removedAt,
		removedBy: cols.removedBy,
		reason: decodeReason(cols.removedReason),
	});
};

/**
 * The inverse: the column values a lifecycle persists to. `Live` clears all
 * three (what {@link restore} writes); `Removed` stamps the triad.
 */
export const toColumns = (lifecycle: EntityLifecycle): RemovalColumns =>
	$match(lifecycle, {
		Live: () => ({removedAt: null, removedBy: null, removedReason: null}),
		Removed: ({removedAt, removedBy, reason}) => ({
			removedAt,
			removedBy,
			removedReason: encodeReason(reason),
		}),
	});

/**
 * Construct the removed state from its audit triad — the one constructor a
 * delete path uses, so it cannot forget an audit field.
 */
export const remove = (input: {
	readonly removedAt: Date;
	readonly removedBy: string;
	readonly reason: RemovalReason;
}): Removed => Removed(input);

/**
 * `restore : Removed → Live`. Defined **only** on `Removed` — restoring a `Live`
 * entity is not expressible because the parameter type excludes it. The removed
 * audit is intentionally dropped: restore brings the content back live; the votes
 * `Vote.clearTarget` wiped are not resurrected (ADR 0096 §4).
 */
export const restore = (_removed: Removed): EntityLifecycle => Live();

/**
 * Exhaustive reason handling via `Match.tagsExhaustive` — the call site that adds
 * a fourth `RemovalReason` without a new branch fails to compile. Returns the
 * Turkish product label a tombstone/moderator surface renders.
 */
export const reasonLabel: (reason: RemovalReason) => string = Match.type<RemovalReason>().pipe(
	Match.tagsExhaustive({
		AuthorDeletion: () => "yazar tarafından silindi",
		Anonymized: () => "hesap silindiği için kaldırıldı",
		Moderated: () => "moderasyon kararıyla kaldırıldı",
	}),
);

/** The originating report of a `Moderated` removal, else null — `Match` exhaustive. */
export const reasonReportId: (reason: RemovalReason) => string | null =
	Match.type<RemovalReason>().pipe(
		Match.tagsExhaustive({
			AuthorDeletion: () => null,
			Anonymized: () => null,
			Moderated: ({reportId}) => reportId,
		}),
	);
