/**
 * `Moderate` — the platform-moderation capability (ADR 0107 §4), carrying ADR
 * 0098 §2's invisible denial forward. A `Capability.Relation` over the `moderates`
 * verb: `Moderate.over(platform)` discharges to a `Grant` iff the actor holds
 * `(actor, "moderates", platform)` (or an ancestor) in the `relation_tuple` store
 * (`RelationStoreLive`), checked fresh per call. It replaces `report/Moderator`'s
 * `user.role` read — authority is now an assigned relation tuple, never a column.
 *
 * Denial is the künye {@link Denied} (`UNAUTHORIZED`), so a non-moderator cannot
 * distinguish "not a moderator" from "not signed in" (the invisible-denial
 * invariant). The instance lives here — künye owns the kamp.us capability
 * instances; the vocab-free mechanism is `@kampus/authz`.
 */
import {
	Capability,
	Grant,
	matchActor,
	key as objectKey,
	platform,
	RelationStore,
} from "@kampus/authz";
import {Effect} from "effect";
import {UserId} from "../../lib/ids.ts";
import {Denied} from "./errors.ts";

/**
 * The `relation_tuple.relation` verb the moderator role rides on — the SINGLE source
 * every moderator read, discharge, and the `user.setRole` runtime write share, so the
 * read/discharge key and the write key can't drift (#3522).
 */
export const MODERATES_RELATION = "moderates";

/**
 * The two platform roles the admin roster surfaces (#3200): `moderator` iff the
 * `moderates` tuple is held, else `member`. The value `user.setRole` assigns (#3522).
 */
export type PlatformRole = "member" | "moderator";

export class Moderate extends Capability.Relation<Moderate>()("kunye/Moderate", {
	relation: MODERATES_RELATION,
	deny: () => new Denied({message: "Moderation authority required"}),
}) {}

// Re-export the platform scope so a moderation surface gates with one import.
export {platform};

/**
 * The stored `relation_tuple` row for `(subject, "moderates", platform)` — the SAME
 * key {@link isModerator} / {@link moderatorsAmong} read and `Moderate.over(platform)`
 * discharges against, resolved through `@kampus/authz`'s canonical `objectKey` (as
 * `RelationStoreLive` does). The `Admin.over(platform)`-gated `user.setRole` writer
 * (#3522) inserts/deletes exactly this row, so the runtime WRITE of the moderator
 * relation can never encode the tuple differently from the read — the read-key-can't-
 * drift invariant, now extended to the write.
 */
export const moderatorTuple = (
	subject: string,
): {subject: string; relation: string; object: string} => ({
	subject,
	relation: MODERATES_RELATION,
	object: objectKey(platform),
});

/**
 * Is `subject` a platform moderator? The SELF-status read behind the trusted `me`
 * view's `isModerator` (#1320): the SAME `(subject, "moderates", platform)` tuple
 * `Moderate.over(platform)` discharges against, read straight off the
 * {@link RelationStore} port keyed by an account id. It takes a subject id (NOT
 * `CurrentActor`), so it answers "is THIS account a moderator" for the viewer's own
 * id and never another's — the `me` resolver passes `CurrentUser`'s id. The frontend
 * gates the divan "yazar yap" (promote) affordance on it, because a dual-role
 * yazar+moderator account reads `tier: "yazar"` and the mod axis can't ride on
 * `tier`. The encoding lives here, next to {@link Moderate}, so the read key can't
 * drift from the discharge key.
 */
export const isModerator = (subject: string): Effect.Effect<boolean, never, RelationStore> =>
	Effect.gen(function* () {
		const store = yield* RelationStore;
		return yield* store.has({subject, relation: "moderates", object: platform});
	});

/**
 * The batched form of {@link isModerator}: which of `subjects` are platform
 * moderators, answered in ONE {@link RelationStore} set-membership read over the
 * `(moderates, platform)` tuple — the by-id loader's join, without the per-row
 * `has` that would make it an in-batch N+1. Same direct-tuple key as `isModerator`,
 * so the batched and single reads can't drift.
 */
export const moderatorsAmong = (
	subjects: ReadonlyArray<string>,
): Effect.Effect<ReadonlySet<string>, never, RelationStore> =>
	Effect.gen(function* () {
		const store = yield* RelationStore;
		return yield* store.hasSubjects({subjects, relation: "moderates", object: platform});
	});

/**
 * EVERY platform moderator's account id — the mod-fan-out recipient set (#1699):
 * every subject holding `(subject, "moderates", platform)`, read off the same
 * direct tuple {@link isModerator} / {@link moderatorsAmong} key. Where those two
 * ANSWER membership for a known candidate, this ENUMERATES the open set a `notify
 * every moderator` emit needs — a recipient set with no candidate ids up front, so
 * neither `has` nor `hasSubjects` can produce it. The tuple key lives here next to
 * {@link Moderate} so the enumeration key can't drift from the discharge key.
 */
export const allModerators = (): Effect.Effect<ReadonlySet<string>, never, RelationStore> =>
	Effect.gen(function* () {
		const store = yield* RelationStore;
		return yield* store.subjectsOf({relation: "moderates", object: platform});
	});

/**
 * Gate `body` behind platform-moderation authority: discharge
 * `Moderate.over(platform)` (the invisible {@link Denied} on failure) and thread
 * the resulting `Grant` into `body`'s R-channel via `Grant.provide`. So `body`
 * can read `yield* Moderate` for the authority-checked moderator identity, and
 * "moderating without a `Grant`" is a compile error — the proof is required by R,
 * not a forgeable field (ADR 0107 §3).
 */
export const requireModeration = <A, E, R>(body: Effect.Effect<A, E, Moderate | R>) =>
	Moderate.over(platform).pipe(Effect.flatMap((grant) => body.pipe(Grant.provide(grant))));

/**
 * The moderator's account id from a discharged `Moderate` grant — the
 * authority-checked identity a moderation write stamps as `resolver_id` /
 * `removed_by`, minted as the shared branded {@link UserId} (see `lib/ids.ts`). A
 * discharged grant is never anonymous (`Moderate.over` fails `Denied` on the
 * `Unauthenticated` arm before minting), so the anonymous arm is unreachable and
 * dies as the defect it would be.
 */
export const moderatorOf = (grant: Grant<Moderate>): Effect.Effect<UserId> =>
	matchActor(grant.actor, {
		onUnauthenticated: () =>
			Effect.die(
				new Error(
					"Moderate grant carried an unauthenticated actor — Moderate.over denies anonymous",
				),
			),
		onHuman: (subject) => Effect.succeed(UserId.make(subject.id)),
		onAgent: (acting) => Effect.succeed(UserId.make(acting.id)),
	});
