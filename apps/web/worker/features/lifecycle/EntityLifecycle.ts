/**
 * A deletable entity's lifecycle as a closed type — the in-memory projection of the
 * persisted `removed_at` / `removed_by` / `removed_reason` / `sandboxed_at` columns.
 * Services branch on the type, never on the raw columns. See ADR 0096; the sandbox
 * dimension is mapped in .patterns/caylak-content-containment.md.
 */
import * as Data from "effect/Data";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import {ReportId} from "../report/ids.ts";

export class AuthorDeletion extends Schema.Class<AuthorDeletion>("lifecycle/AuthorDeletion")({
	_tag: Schema.tag("AuthorDeletion"),
}) {}

export class Anonymized extends Schema.Class<Anonymized>("lifecycle/Anonymized")({
	_tag: Schema.tag("Anonymized"),
}) {}

export class Moderated extends Schema.Class<Moderated>("lifecycle/Moderated")({
	_tag: Schema.tag("Moderated"),
	// Branded so a report/target/user id swap is a compile error; minted via
	// `ReportId.make(...)` at the report→service boundary (`report/mutations.ts`).
	reportId: ReportId,
}) {}

export const RemovalReason = Schema.Union([AuthorDeletion, Anonymized, Moderated]);
export type RemovalReason = typeof RemovalReason.Type;

// The only seam between the `removed_reason` column and the domain reason — the
// column is never parsed ad-hoc elsewhere.
const ReasonFromJson = Schema.fromJsonString(RemovalReason);
export const decodeReason = Schema.decodeUnknownSync(ReasonFromJson);
export const encodeReason = Schema.encodeSync(ReasonFromJson);

/**
 * Exactly three states, so "sandboxed-AND-removed" is unrepresentable. `Removed`
 * still carries the pre-removal `sandboxedAt` (null if it was `Live`) so a
 * remove→restore round-trip is faithful — see {@link restore}.
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

export interface LifecycleColumns {
	readonly removedAt: Date | null;
	readonly removedBy: string | null;
	readonly removedReason: string | null;
	readonly sandboxedAt: Date | null;
}
export type RemovalColumns = LifecycleColumns;

/**
 * The single projection seam (ADR 0096 §2). Removal takes precedence over sandbox: a
 * removed row reads `Removed` and carries its `sandboxedAt` for {@link restore}. A
 * `removedAt` with a missing `removedBy`/`removedReason` is a corrupt half-removal the
 * domain can't represent, so it throws rather than projecting a fabricated audit.
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
 * A `removed`-AND-`sandboxed` column pair is not a contradiction — it is a removed row
 * remembering it was sandboxed. {@link fromColumns} still projects it to `Removed`.
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
 * The one constructor a delete path uses, so it cannot forget an audit field. Derive
 * `sandboxedAt` from the row's current lifecycle via {@link sandboxedAtOf}.
 */
export const remove = (input: {
	readonly removedAt: Date;
	readonly removedBy: string;
	readonly reason: RemovalReason;
	readonly sandboxedAt: Date | null;
}): Removed => Removed(input);

// A `Removed` input (already deleted) keeps its carried marker, so a re-delete is
// idempotent.
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

export const sandbox = (input: {readonly sandboxedAt: Date}): Sandboxed => Sandboxed(input);

// Typed `Sandboxed → Live` on purpose: promoting a `Live`/`Removed` entity must not
// be expressible.
export const promote = (_sandboxed: Sandboxed): EntityLifecycle => Live();

/**
 * `canSeeSandboxed` is true only for a moderator holding the discharged `Moderate`
 * authority (ADR 0107). Deliberately a plain value, not a service — the decision is
 * pure, so the read layer and the matrix test apply the same rule.
 */
export interface SandboxViewer {
	readonly viewerId: string | null;
	readonly canSeeSandboxed: boolean;
}

export const anonymousViewer: SandboxViewer = {viewerId: null, canSeeSandboxed: false};

// Exported so the SQL mirror (`SandboxVisibility.sandboxVisibleWhere`) iterates the SAME
// tag set: a new tag then has no SQL arm and fails to compile.
export type LifecycleTag = EntityLifecycle["_tag"];

// A value, not inline logic per encoding, so `isVisibleTo` (runtime) and
// `sandboxVisibleWhere` (SQL) cannot silently diverge for a state.
export type LifecycleVisibilityRule = "Everyone" | "NoOne" | "AuthorOrModerator";

// The single source of the çaylak-sandbox visibility boundary. Exhaustive by its type:
// a new lifecycle tag with no entry is a compile error here, forcing both encodings to
// gain the state rather than one silently mis-filtering.
export const lifecycleVisibilityRule: Record<LifecycleTag, LifecycleVisibilityRule> = {
	Live: "Everyone",
	Removed: "NoOne",
	Sandboxed: "AuthorOrModerator",
};

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

// The pure visibility decision the read queries' SQL predicate mirrors and the
// visibility-matrix test targets directly.
export const isVisibleTo = (
	lifecycle: EntityLifecycle,
	authorId: string,
	viewer: SandboxViewer,
): boolean => ruleVisibleTo(lifecycleVisibilityRule[lifecycle._tag], authorId, viewer);

export const reasonLabel: (reason: RemovalReason) => string = Match.type<RemovalReason>().pipe(
	Match.tagsExhaustive({
		AuthorDeletion: () => "yazar tarafından silindi",
		Anonymized: () => "hesap silindiği için kaldırıldı",
		Moderated: () => "moderasyon kararıyla kaldırıldı",
	}),
);

export const reasonReportId: (reason: RemovalReason) => ReportId | null =
	Match.type<RemovalReason>().pipe(
		Match.tagsExhaustive({
			AuthorDeletion: () => null,
			Anonymized: () => null,
			Moderated: ({reportId}) => reportId,
		}),
	);
