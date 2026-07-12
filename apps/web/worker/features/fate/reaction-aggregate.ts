/**
 * `stampReactionAggregate` — the reaction analogue of `stampViewerScalars`
 * (`viewer-scalars.ts`), for the ONE reaction aggregate field the `post` /
 * `comment` / `definition` fate views expose (#1862). Where `stampViewerScalars`
 * stamps a `boolean | null` presence scalar, this stamps a structured
 * `ReactionAggregate` (per-emoji counts + the viewer's own emoji) — reactions
 * carry a VALUE (the emoji) and a per-target COUNT, so a boolean scalar can't
 * carry them.
 *
 * The N+1-avoidance contract is structural, exactly as the viewer-scalar helper:
 * one batched `Reaction.readAggregate` (a single `GROUP BY` read + one `readMine`)
 * for the whole page, never a per-row read. A target absent from the batch (no
 * reactions, and the viewer hasn't reacted) is stamped with the empty aggregate,
 * so the field is ALWAYS present on the wire — a reader (human or agent) sees
 * `reactions` on every row the way it sees `score`, never a missing field. The
 * anonymous-viewer / empty-page short-circuit lives in `readAggregate`.
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
 * Run the one batched aggregate read over `rows`' ids, then stamp `reactions`
 * onto each row as its aggregate (or the empty aggregate when the target has
 * none). One read for the whole batch — never per row. The stamped field is
 * *added* to the input row shape, so a read that wants the aggregate must route
 * through here (a path that skips the stamp never produces the field).
 *
 * `readAggregate` itself issues TWO D1 reads (the per-target `GROUP BY` + the
 * viewer's `readMine`); pass `{concurrency: "unbounded"}` to fan those two out so
 * this stamp is a single wave phase when run inside `parallelStampWave`. Default
 * (absent) keeps them sequential — today's behavior for every non-opted caller.
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
