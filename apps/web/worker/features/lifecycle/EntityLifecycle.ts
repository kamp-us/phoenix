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
 * The lifecycle state of a deletable entity (ADR 0096, extended by #1205). A
 * closed union of exactly three states, so an entity is *one* of them — which is
 * what makes the çaylak-sandbox invariant hold by construction: a `Sandboxed`
 * cannot also be `Removed` (they are distinct tags), so "sandboxed-AND-removed" is
 * unrepresentable, no flag-pair to fall into a contradictory combination.
 *
 * - `Live` — public, the default; carries no audit.
 * - `Sandboxed` — çaylak content held in the mod-only sandbox (#1205): visible to
 *   its author + moderators only, until promotion (#1206) transitions it to `Live`.
 * - `Removed` — soft-deleted, carrying the full audit triad; there is no `Removed`
 *   without `removedAt` + `removedBy` + `reason`.
 */
export type EntityLifecycle = Data.TaggedEnum<{
	// biome-ignore lint/complexity/noBannedTypes: Data.taggedEnum needs the literal `{}` for a payload-less member; `Record<string, never>` makes `Live()` demand an arg.
	Live: {};
	Sandboxed: {
		readonly sandboxedAt: Date;
	};
	Removed: {
		readonly removedAt: Date;
		readonly removedBy: string;
		readonly reason: RemovalReason;
	};
}>;

export const EntityLifecycle = Data.taggedEnum<EntityLifecycle>();
export const {Live, Sandboxed, Removed, $is, $match} = EntityLifecycle;

export type Removed = Extract<EntityLifecycle, {readonly _tag: "Removed"}>;
export type Sandboxed = Extract<EntityLifecycle, {readonly _tag: "Sandboxed"}>;

export const isRemoved = $is("Removed");
export const isLive = $is("Live");
export const isSandboxed = $is("Sandboxed");

/**
 * The persisted lifecycle columns, exactly as they sit on a content row: the ADR
 * 0096 removal triad plus the #1205 `sandboxedAt` marker. `removedAt` AND
 * `sandboxedAt` both null ⇒ `Live`. This is the only shape the projection reads.
 * `RemovalColumns` stays as a name alias for the `removal.ts` call sites that
 * predate the sandbox dimension.
 */
export interface LifecycleColumns {
	readonly removedAt: Date | null;
	readonly removedBy: string | null;
	readonly removedReason: string | null;
	readonly sandboxedAt: Date | null;
}
export type RemovalColumns = LifecycleColumns;

/**
 * Reconstitute the lifecycle union from a row's raw columns — the single
 * projection seam ADR 0096 §2 mandates (services call this, never branch on the
 * columns). Removal takes precedence over sandbox (a removed row reads `Removed`
 * regardless of `sandboxedAt`; `toColumns` never persists both, so the precedence
 * is only a defensive belt). A row with `removedAt` set but a missing
 * `removedBy`/`removedReason` is a corrupt half-removal the domain can't
 * represent; we surface it loudly rather than projecting a fabricated audit.
 */
export const fromColumns = (cols: LifecycleColumns): EntityLifecycle => {
	if (cols.removedAt !== null) {
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
	}
	if (cols.sandboxedAt !== null) return Sandboxed({sandboxedAt: cols.sandboxedAt});
	return Live();
};

/**
 * The inverse: the column values a lifecycle persists to. Each member writes a
 * shape with **at most one** of `removedAt`/`sandboxedAt` non-null — so the
 * persisted form can never hold the sandboxed-AND-removed contradiction the union
 * already forbids in memory. `Live` clears everything (what {@link restore} /
 * {@link promote} write); `Sandboxed` stamps only `sandboxedAt`; `Removed` stamps
 * only the triad.
 */
export const toColumns = (lifecycle: EntityLifecycle): LifecycleColumns =>
	$match(lifecycle, {
		Live: () => ({removedAt: null, removedBy: null, removedReason: null, sandboxedAt: null}),
		Sandboxed: ({sandboxedAt}) => ({
			removedAt: null,
			removedBy: null,
			removedReason: null,
			sandboxedAt,
		}),
		Removed: ({removedAt, removedBy, reason}) => ({
			removedAt,
			removedBy,
			removedReason: encodeReason(reason),
			sandboxedAt: null,
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
 * Construct the sandboxed state — the one constructor a çaylak create path uses to
 * hold new content in the mod-only sandbox (#1205).
 */
export const sandbox = (input: {readonly sandboxedAt: Date}): Sandboxed => Sandboxed(input);

/**
 * `promote : Sandboxed → Live`. Defined **only** on `Sandboxed` — promoting a
 * `Live`/`Removed` entity is not expressible because the parameter type excludes
 * them. This is the seam the çaylak→yazar promotion (#1206) flips a sandboxed
 * backlog through; it lives here so the transition is one place, symmetric with
 * {@link restore}.
 */
export const promote = (_sandboxed: Sandboxed): EntityLifecycle => Live();

/**
 * The viewer a sandbox-visibility decision is made against. `viewerId` is the
 * signed-in account id (null = anonymous/public); `canSeeSandboxed` is true only
 * for a moderator (the discharged {@link Moderate} authority — ADR 0107), who sees
 * the full sandbox. A non-moderator member sees only the sandboxed content they
 * authored. Deliberately a plain value, not a service: the visibility decision is
 * pure, so the resolver resolves the viewer once and the read layer + the matrix
 * test both apply the same rule.
 */
export interface SandboxViewer {
	readonly viewerId: string | null;
	readonly canSeeSandboxed: boolean;
}

/** An anonymous/public viewer — sees only `Live`. The safe default. */
export const anonymousViewer: SandboxViewer = {viewerId: null, canSeeSandboxed: false};

/**
 * The pure visibility decision (#1205) — the rule the read queries' SQL predicate
 * mirrors and the visibility-matrix test targets directly. A piece of content with
 * `lifecycle`/`authorId` is visible to `viewer` iff:
 *
 * - `Live` — visible to everyone.
 * - `Removed` — hidden from the content reads (the existing `removed_at IS NULL`
 *   guard, unchanged — moderators review removed content through a different queue).
 * - `Sandboxed` — visible only to a moderator (`canSeeSandboxed`) or the author
 *   (`viewerId === authorId`); hidden from anonymous + every other member.
 */
export const isVisibleTo = (
	lifecycle: EntityLifecycle,
	authorId: string,
	viewer: SandboxViewer,
): boolean =>
	$match(lifecycle, {
		Live: () => true,
		Removed: () => false,
		Sandboxed: () => viewer.canSeeSandboxed || viewer.viewerId === authorId,
	});

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
