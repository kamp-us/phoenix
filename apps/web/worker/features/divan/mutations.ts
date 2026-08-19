/**
 * The divan vote mutation — score a SANDBOXED çaylak item, crediting the author's global
 * karma. `yield* ViewDivan` makes the cast unreachable without a discharged grant, so the
 * "non-gated actor cannot vote a sandboxed item" guarantee is a compile error, not an `if`
 * (ADR 0107). This is the ONLY caller of `Vote.castOnSandboxed`; every other vote path
 * uses `Vote.cast`, which rejects a sandboxed target.
 */
import {CurrentUser, Fate} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {parseTargetKey, type TargetKind, targetKey} from "../../db/target-kind.ts";
import {notifyDivanVote} from "../bildirim/rite-emitters.ts";
import {Denied} from "../kunye/errors.ts";
import {resolveTandem} from "../pasaport/tandem.ts";
import {Vote} from "../vote/Vote.ts";
import {requireDivanAccess, ViewDivan} from "./gate.ts";
import {DivanVoteReceiptView} from "./views.ts";

const DivanVoteInput = Schema.Struct({
	/** The backlog item's `<kind>:<itemId>` composite id (see `DivanBacklogItemView`). */
	id: Schema.String,
	/** Up-only presence: `true` casts, `false` retracts. */
	value: Schema.Boolean,
});

/**
 * The backlog read only ever emits well-formed ids, so a `null` here means a hand-crafted
 * request — the caller collapses it to the invisible `Denied` rather than a parse error.
 */
const parseItemId = (id: string): {targetKind: TargetKind; targetId: string} | null => {
	const parsed = parseTargetKey(id);
	return parsed && {targetKind: parsed.kind, targetId: parsed.id};
};

export const mutations = {
	"divan.vote": Fate.mutation(
		{
			input: DivanVoteInput,
			type: DivanVoteReceiptView,
			error: Schema.Union([Denied]),
		},
		Effect.fn("divan.vote")(function* ({input}) {
			const ref = parseItemId(input.id);
			if (ref === null) {
				return yield* new Denied({message: "Oy verilecek içerik bulunamadı."});
			}
			return yield* requireDivanAccess(voteGated(ref.targetKind, ref.targetId, input.value));
		}),
	),
};

// The voter is read OPTIONALLY, not via `CurrentUser.required`, so an anonymous actor gets
// the invisible `Denied` and never a "not signed in" leak. `VoteTargetNotFound` collapses
// the same way, keeping this private surface opaque.
const voteGated = Effect.fn("divan.voteGated")(function* (
	targetKind: TargetKind,
	targetId: string,
	value: boolean,
) {
	yield* ViewDivan;
	const {user} = yield* CurrentUser;
	if (!user) return yield* new Denied({message: "Oy verilecek içerik bulunamadı."});
	const vote = yield* Vote;
	const result = yield* vote
		.castOnSandboxed({userId: user.id, targetKind, targetId, value})
		.pipe(
			Effect.catchTag("vote/VoteTargetNotFound", () =>
				Effect.fail(new Denied({message: "Oy verilecek içerik bulunamadı."})),
			),
		);
	// A karma move may have crossed the reduced promotion bar. Keyed on the SERVER-derived
	// author id, never a client-supplied one; idempotent, and it holds no authority of its
	// own, so it stays inside this gated path.
	if (result.changed) yield* resolveTandem(result.authorId);
	// Only a LANDED upvote notifies — a retraction stays silent, because the aggregate is
	// "attention received", not a live score. The emitter swallows its own failures, so it
	// can never fail this already-committed cast.
	if (value && result.changed) {
		yield* notifyDivanVote({
			authorId: result.authorId,
			actorId: user.id,
			targetKind: result.targetKind,
			targetId: result.targetId,
		});
	}
	return {
		__typename: "DivanVoteReceipt" as const,
		id: targetKey(result.targetKind, result.targetId),
		score: result.score,
		myVote: result.myVote,
	};
});
