/**
 * `Moderate` — the platform-moderation capability (ADR 0107 §4). A
 * `Capability.Relation` over the `moderates` verb, checked fresh per call against the
 * `relation_tuple` store: authority is an assigned tuple, never a `user.role` column.
 *
 * Denial is the künye {@link Denied} (`UNAUTHORIZED`), so a non-moderator cannot tell
 * "not a moderator" from "not signed in" (ADR 0098 §2's invisible denial).
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
 * The single relation verb every moderator read, discharge, and `user.setRole` write
 * shares, so the read/discharge key and the write key can't drift.
 */
export const MODERATES_RELATION = "moderates";

/** `moderator` iff the `moderates` tuple is held, else `member`. */
export type PlatformRole = "member" | "moderator";

export class Moderate extends Capability.Relation<Moderate>()("kunye/Moderate", {
	relation: MODERATES_RELATION,
	deny: () => new Denied({message: "Moderation authority required"}),
}) {}

export {platform};

/**
 * The stored row for `(subject, "moderates", platform)` — the SAME key the reads below
 * and `Moderate.over(platform)` resolve, so the runtime write of the moderator relation
 * can never encode the tuple differently from the read.
 */
export const moderatorTuple = (
	subject: string,
): {subject: string; relation: string; object: string} => ({
	subject,
	relation: MODERATES_RELATION,
	object: objectKey(platform),
});

/**
 * Is `subject` a platform moderator? Takes a subject id (NOT `CurrentActor`), so the `me`
 * resolver passes `CurrentUser`'s id and it can never answer for another account. The
 * frontend gates the divan promote affordance on it, because a dual-role yazar+moderator
 * reads `tier: "yazar"` and the mod axis can't ride on `tier`.
 */
export const isModerator = (subject: string): Effect.Effect<boolean, never, RelationStore> =>
	Effect.gen(function* () {
		const store = yield* RelationStore;
		return yield* store.has({subject, relation: "moderates", object: platform});
	});

/**
 * The batched form of {@link isModerator}: ONE set-membership read over the
 * `(moderates, platform)` tuple, so a by-id loader's join is not an in-batch N+1.
 */
export const moderatorsAmong = (
	subjects: ReadonlyArray<string>,
): Effect.Effect<ReadonlySet<string>, never, RelationStore> =>
	Effect.gen(function* () {
		const store = yield* RelationStore;
		return yield* store.hasSubjects({subjects, relation: "moderates", object: platform});
	});

/**
 * EVERY platform moderator's account id. Where the two reads above ANSWER membership for
 * a known candidate, this ENUMERATES the open recipient set a mod fan-out needs.
 */
export const allModerators = (): Effect.Effect<ReadonlySet<string>, never, RelationStore> =>
	Effect.gen(function* () {
		const store = yield* RelationStore;
		return yield* store.subjectsOf({relation: "moderates", object: platform});
	});

/**
 * Gate `body` behind moderation authority, threading the `Grant` into its R channel — so
 * moderating without a grant is a compile error, not a forgeable field (ADR 0107 §3).
 */
export const requireModeration = <A, E, R>(body: Effect.Effect<A, E, Moderate | R>) =>
	Moderate.over(platform).pipe(Effect.flatMap((grant) => body.pipe(Grant.provide(grant))));

/**
 * The moderator's account id from a discharged grant. `Moderate.over` fails `Denied` on
 * the anonymous arm before minting, so that arm here is unreachable and dies as a defect.
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
