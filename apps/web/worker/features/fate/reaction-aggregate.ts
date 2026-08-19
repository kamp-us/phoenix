/**
 * The reaction analogue of `stampViewerScalars` (`viewer-scalars.ts`), stamping a
 * structured `ReactionAggregate` where that one stamps a boolean presence scalar.
 *
 * The N+1-avoidance contract is structural: one batched `readAggregate` per page,
 * never a per-row read. A target absent from the batch is stamped with the empty
 * aggregate, so the field is ALWAYS present on the wire, never missing.
 */
import type {Effect} from "effect";
import {Effect as Eff} from "effect";
import type {Concurrency} from "effect/Types";
import type {TargetKind} from "../../db/target-kind.ts";
import {
	EMPTY_REACTION_AGGREGATE,
	type Reaction,
	type ReactionAggregate,
} from "../reaction/Reaction.ts";

/**
 * The stamped field is *added* to the input row shape, so a read that wants the
 * aggregate must route through here — a path that skips the stamp cannot produce it.
 *
 * `readAggregate` issues TWO D1 reads; pass `{concurrency: "unbounded"}` to fan them
 * out so this stamp is a single wave phase inside `parallelStampWave`.
 */
export const stampReactionAggregate = <R extends {id: string}>(
	reactionSvc: typeof Reaction.Service,
	kind: TargetKind,
	rows: ReadonlyArray<R>,
	viewerId: string | null | undefined,
	options?: {readonly concurrency?: Concurrency},
): Effect.Effect<Array<R & {reactions: ReactionAggregate}>> =>
	Eff.gen(function* () {
		const ids = rows.map((row) => row.id);
		const byId = yield* reactionSvc.readAggregate(viewerId, kind, ids, options);
		return rows.map((row) => ({
			...row,
			reactions: byId.get(row.id) ?? EMPTY_REACTION_AGGREGATE,
		}));
	});
