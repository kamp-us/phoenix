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
import {ReportId} from "../report/ids.ts";

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
	// The originating report, branded (#2820, deferred slice of #2721): the content
	// features mint it via `ReportId.make(...)` at the report→service boundary
	// (`report/mutations.ts`), so a report/target/user id swap is a compile error here.
	reportId: ReportId,
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
 *   without `removedAt` + `removedBy` + `reason`. It also carries the pre-removal
 *   `sandboxedAt` (null if the content was `Live` when removed) so a remove→restore
 *   round-trip is *faithful*: restoring sandboxed content returns it to `Sandboxed`,
 *   not `Live` — the çaylak sandbox-escape fix (#1811). A `Removed`-with-`sandboxedAt`
 *   is still `Removed` (the removal is the live fact); the marker is carried, not
 *   projected, so promotion to `Live` stays the mod-only path (#1206).
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
		readonly sandboxedAt: Date | null;
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
 * columns). Removal takes precedence over sandbox: a removed row reads `Removed`
 * *and carries its `sandboxedAt`* (the pre-removal sandbox marker, #1811) so
 * {@link restore} can round-trip it faithfully — a removed-AND-sandboxed row is a
 * çaylak's deleted sandboxed content, still `Removed` (the removal is the live
 * fact), with the sandbox marker preserved for restore, not projected. A row with
 * `removedAt` set but a missing `removedBy`/`removedReason` is a corrupt
 * half-removal the domain can't represent; we surface it loudly rather than
 * projecting a fabricated audit.
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
			sandboxedAt: cols.sandboxedAt,
		});
	}
	if (cols.sandboxedAt !== null) return Sandboxed({sandboxedAt: cols.sandboxedAt});
	return Live();
};

/**
 * The inverse: the column values a lifecycle persists to. `Live` clears
 * everything (what {@link promote} writes, and what {@link restore} writes for
 * content that was live before removal); `Sandboxed` stamps only `sandboxedAt`
 * (what {@link restore} writes for content that was sandboxed before removal);
 * `Removed` stamps the triad **plus** the preserved pre-removal `sandboxedAt`
 * (null if it was live) so the marker survives the round-trip (#1811). The
 * `removed`-AND-`sandboxed` column pair is not a contradiction — it is a removed
 * row remembering it was sandboxed; the removal-precedence in {@link fromColumns}
 * still projects it to `Removed`, and only a mod's promotion clears the marker to
 * reach `Live`.
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
		Removed: ({removedAt, removedBy, reason, sandboxedAt}) => ({
			removedAt,
			removedBy,
			removedReason: encodeReason(reason),
			sandboxedAt,
		}),
	});

/**
 * Construct the removed state from its audit triad plus the pre-removal
 * `sandboxedAt` — the one constructor a delete path uses, so it cannot forget an
 * audit field. `sandboxedAt` is the marker the row carried *before* the delete
 * (null if it was `Live`); carrying it through `Removed` is what lets
 * {@link restore} round-trip sandboxed çaylak content back to `Sandboxed` instead
 * of leaking it to `Live` (#1811). A delete path derives it from the row's current
 * lifecycle — `isSandboxed(current) ? current.sandboxedAt : null` — via
 * {@link sandboxedAtOf}.
 */
export const remove = (input: {
	readonly removedAt: Date;
	readonly removedBy: string;
	readonly reason: RemovalReason;
	readonly sandboxedAt: Date | null;
}): Removed => Removed(input);

/**
 * The `sandboxedAt` a {@link remove} should preserve for `current`'s pre-removal
 * lifecycle: the marker if it was `Sandboxed`, else `null`. The one seam a delete
 * path reads so it can't hand-derive the marker wrong (#1811). A `Removed` input
 * (already deleted) keeps its carried marker — idempotent under a re-delete guard.
 */
export const sandboxedAtOf = (current: EntityLifecycle): Date | null =>
	$match(current, {
		Live: () => null,
		Sandboxed: ({sandboxedAt}) => sandboxedAt,
		Removed: ({sandboxedAt}) => sandboxedAt,
	});

/**
 * `restore : Removed → Sandboxed | Live`. Defined **only** on `Removed` —
 * restoring a `Live`/`Sandboxed` entity is not expressible because the parameter
 * type excludes it. Restore is **sandbox-faithful** (#1811): content that was
 * `Sandboxed` before removal returns to `Sandboxed` (its `sandboxedAt` preserved
 * through the `Removed` state), and only content that was `Live` returns to `Live`.
 * This closes the çaylak self-escape — a delete→restore round-trip can never clear
 * a sandbox marker, so no self-service path reaches `Live`/the always-Live
 * broadcast without a mod's `promote`. The removed audit is intentionally dropped;
 * votes `Vote.clearTarget` wiped are not resurrected (ADR 0096 §4).
 */
export const restore = (removed: Removed): EntityLifecycle =>
	removed.sandboxedAt !== null ? Sandboxed({sandboxedAt: removed.sandboxedAt}) : Live();

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
 * The tag of an {@link EntityLifecycle} state — the closed discriminant both the
 * in-memory decision ({@link isVisibleTo}) and the SQL mirror
 * (`SandboxVisibility.sandboxVisibleWhere`) key their visibility rule on. Exported so
 * the SQL side can iterate the SAME tag set exhaustively (a new tag then has no SQL
 * arm and fails to compile), instead of re-deriving the rule from booleans (#2013).
 */
export type LifecycleTag = EntityLifecycle["_tag"];

/**
 * The per-state visibility rule as a closed union of exactly three arms — the
 * single-sourced shape both encodings interpret (#2013). A lifecycle state permits a
 * viewer by one of:
 *
 * - `Everyone` — the state is public (`Live`).
 * - `NoOne` — the state is hidden from content reads (`Removed`; moderators review it
 *   through a separate queue, not these reads).
 * - `AuthorOrModerator` — visible only to a moderator (`canSeeSandboxed`) or the
 *   authoring account (`Sandboxed`, the #1205 çaylak rule).
 *
 * Making the rule a value — not inline logic duplicated per encoding — is what lets
 * `isVisibleTo` (runtime) and `sandboxVisibleWhere` (SQL) both read it, so they cannot
 * silently diverge for a state.
 */
export type LifecycleVisibilityRule = "Everyone" | "NoOne" | "AuthorOrModerator";

/**
 * The single source of the çaylak-sandbox visibility boundary (#1205, #2013): each
 * lifecycle tag → its {@link LifecycleVisibilityRule}, keyed by the closed
 * {@link LifecycleTag} discriminant. This `Record` over the tag union is exhaustive by
 * its type — a new lifecycle tag with no entry is a **compile error here**, forcing
 * both encodings (which derive from this map) to gain the state rather than one
 * silently mis-filtering. This replaces the old two-place encoding where the SQL
 * builder branched on booleans and a 4th tag would have compiled clean at the DB.
 */
export const lifecycleVisibilityRule: Record<LifecycleTag, LifecycleVisibilityRule> = {
	Live: "Everyone",
	Removed: "NoOne",
	Sandboxed: "AuthorOrModerator",
};

/**
 * Interpret a {@link LifecycleVisibilityRule} against a viewer + the content's author
 * — the one place a rule becomes a boolean, shared by {@link isVisibleTo} and (via the
 * SQL arm builder) the read-query predicate. `AuthorOrModerator` is visible to a
 * moderator (`canSeeSandboxed`) or the author (`viewerId === authorId`).
 */
export const ruleVisibleTo = (
	rule: LifecycleVisibilityRule,
	authorId: string,
	viewer: SandboxViewer,
): boolean => {
	switch (rule) {
		case "Everyone":
			return true;
		case "NoOne":
			return false;
		case "AuthorOrModerator":
			return viewer.canSeeSandboxed || viewer.viewerId === authorId;
	}
};

/**
 * The pure visibility decision (#1205) — the rule the read queries' SQL predicate
 * mirrors and the visibility-matrix test targets directly. A piece of content with
 * `lifecycle`/`authorId` is visible to `viewer` iff its state's
 * {@link lifecycleVisibilityRule} permits them:
 *
 * - `Live` (`Everyone`) — visible to everyone.
 * - `Removed` (`NoOne`) — hidden from the content reads (the existing
 *   `removed_at IS NULL` guard, unchanged — moderators review removed content through a
 *   different queue).
 * - `Sandboxed` (`AuthorOrModerator`) — visible only to a moderator
 *   (`canSeeSandboxed`) or the author (`viewerId === authorId`); hidden from anonymous
 *   + every other member.
 *
 * Reads the rule off {@link lifecycleVisibilityRule} keyed by the lifecycle tag, so
 * this and the SQL encoding share ONE source of the rule.
 */
export const isVisibleTo = (
	lifecycle: EntityLifecycle,
	authorId: string,
	viewer: SandboxViewer,
): boolean => ruleVisibleTo(lifecycleVisibilityRule[lifecycle._tag], authorId, viewer);

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
export const reasonReportId: (reason: RemovalReason) => ReportId | null =
	Match.type<RemovalReason>().pipe(
		Match.tagsExhaustive({
			AuthorDeletion: () => null,
			Anonymized: () => null,
			Moderated: ({reportId}) => reportId,
		}),
	);
