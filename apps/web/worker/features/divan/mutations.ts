/**
 * The divan vote mutation (#1288, epic #1202) — score a SANDBOXED çaylak item from inside
 * the proving ground, crediting the author's GLOBAL karma so a sandboxed çaylak can earn
 * toward the reduced çaylak→yazar promotion bar (#1289).
 *
 * The gate, exactly the read model's (`lists.ts`): {@link requireDivanAccess} (yazar OR
 * mod) — `yield* ViewDivan` makes the cast unreachable without the discharged grant, so a
 * çaylak / public / anonymous actor is denied the invisible {@link Denied}. This IS the
 * "non-gated actor cannot vote a sandboxed item" guarantee — a compile-error gate, not an
 * `if` (ADR 0107).
 *
 * The cast itself delegates to `Vote.castOnSandboxed` — the ONLY caller of the
 * sandbox-permitting path. The inline sözlük/pano vote paths use `Vote.cast`, which rejects a
 * sandboxed target, so the divan is the only surface that can score sandboxed content. The
 * karma + scoring batch is the shared Vote engine unchanged: GLOBAL `user_profile.total_karma`
 * (D2, ADR 0050) and `+1` per vote with the gate admitting yazar and mod identically (D3).
 *
 * After a vote moves the author's karma it fires `resolveTandem` (#1289) — the karma side of the
 * order-independent çaylak→yazar promotion tandem — so a bar-crossing vote with an already-active
 * vouch auto-promotes. `resolveTandem` holds no authority of its own (it only re-checks the
 * completed-tandem invariant), so it stays inside this same divan-gated path.
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
	/** Up-only presence: `true` casts the upvote, `false` retracts it. */
	value: Schema.Boolean,
});

/**
 * Split a `<kind>:<itemId>` divan item id back into its target, or `null` if malformed /
 * unknown-kind — the shared {@link parseTargetKey} codec, remapped to the vote engine's
 * `{targetKind, targetId}` field names. The backlog read only ever emits well-formed ids,
 * so a `null` here is a hand-crafted request past the gate — the caller collapses it to the
 * invisible `Denied`, keeping the private surface opaque.
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

// The post-gate cast body — runnable only with a `ViewDivan` grant in R (`requireDivanAccess`
// provides it); `yield* ViewDivan` IS the divan audience gate, so casting without a discharged
// grant is a compile error. The voter is read OPTIONALLY (not `CurrentUser.required`) so an
// anonymous actor gets the gate's invisible `Denied`, never a "not signed in" leak — though the
// gate already denied them, since both arms (yazar / mod) need authentication. Delegates to the
// sandbox-permitting `Vote.castOnSandboxed`; a `VoteTargetNotFound` (raced soft-delete) collapses
// to the invisible `Denied`, keeping the surface opaque and the error union `{Denied}`.
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
	// The karma-side promotion trigger (#1289): a vote that moved the AUTHOR's karma may have
	// crossed the reduced bar — re-evaluate the order-independent tandem so a bar-crossing vote
	// with an already-active vouch auto-promotes the çaylak. `resolveTandem` reads both halves
	// fresh, is idempotent, and holds no authority of its own (it only checks the completed-tandem
	// invariant), so it stays inside this divan-gated path with no new authority surface. Keyed on
	// the SERVER-derived `result.authorId`, never a client-supplied id. Only on a real karma move.
	if (result.changed) yield* resolveTandem(result.authorId);
	// Rite feedback (#1695): a LANDED upvote (not a retraction, not an idempotent
	// no-op) notifies the item's author — aggregated per item, self-suppressed,
	// flag-gated and swallowed inside the emitter, so it can never fail this
	// committed cast. A retraction stays silent (no decrement: the aggregate is
	// "attention received", not a live score).
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
