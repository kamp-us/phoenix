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
import {Capability, Grant, matchActor, platform, RelationStore} from "@kampus/authz";
import {Effect} from "effect";
import {Denied} from "./errors.ts";

export class Moderate extends Capability.Relation<Moderate>()("kunye/Moderate", {
	relation: "moderates",
	deny: () => new Denied({message: "Moderation authority required"}),
}) {}

// Re-export the platform scope so a moderation surface gates with one import.
export {platform};

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
 * `removed_by`. A discharged grant is never anonymous (`Moderate.over` fails
 * `Denied` on the `Unauthenticated` arm before minting), so the anonymous arm is
 * unreachable and dies as the defect it would be.
 */
export const moderatorOf = (grant: Grant<Moderate>): Effect.Effect<string> =>
	matchActor(grant.actor, {
		onUnauthenticated: () =>
			Effect.die(
				new Error(
					"Moderate grant carried an unauthenticated actor — Moderate.over denies anonymous",
				),
			),
		onHuman: (subject) => Effect.succeed(subject.id),
		onAgent: (acting) => Effect.succeed(acting.id),
	});
