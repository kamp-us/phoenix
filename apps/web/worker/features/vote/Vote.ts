/**
 * Vote — the polymorphic vote service. One canonical write surface
 * (`Vote.cast`) for the three vote targets: `definition`, `post`, `comment`.
 *
 * Voting is up-only in the MVP: a vote is a pure presence — `cast({value: true})`
 * casts, `{value: false}` retracts — so invalid states (down-vote semantics, a
 * vote *weight*) are structurally unrepresentable; there is no number to misuse.
 *
 * The feature-local vote table (`definition_vote`/`post_vote`/`comment_vote`,
 * PK `(target_id, voter_id)`) is the score-truth source; the score cached on
 * the target row is rebuilt from `COUNT(*)` on it. The cross-product
 * `user_vote` table (PK `(user_id, target_kind, target_id)`) powers `myVote`.
 *
 * Atomicity invariant: every state-changing cast lands all four mutations —
 * vote-table upsert/delete, score-cache update, `user_vote` mirror, and karma
 * bump (via {@link KarmaBump}) — in one batch that commits or rolls back as a
 * unit. See ADR 0014 (batch as service method).
 */
import {and, eq, inArray} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, type DrizzleDb, orDieAccess, type Stmt} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import type {TargetKind} from "../../db/target-kind.ts";
import {type TargetRecordMeta, targetTable} from "../../db/target-table.ts";
import {
	VOTE_REQUIRED_TIER,
	VoterNotEligible,
	VoteTargetNotFound,
	VoteTargetSandboxed,
} from "./errors.ts";

// Re-exported from `db/target-kind.ts` (its source-of-truth home) for callers
// that prefer importing it from `./Vote`.
export type {TargetKind};

export interface VoteInput {
	userId: string;
	targetKind: TargetKind;
	targetId: string;
	/** Up-only presence intent: `true` casts the upvote, `false` retracts it. */
	value: boolean;
}

export interface VoteResult {
	targetKind: TargetKind;
	targetId: string;
	/**
	 * The target's author — the karma recipient of this cast. Surfaced so a caller can
	 * fire an author-keyed downstream effect (e.g. the divan vote path re-evaluating the
	 * çaylak→yazar promotion tandem on a bar-crossing vote, #1288/#1289) on the
	 * **server-derived** author, never a client-supplied one.
	 */
	authorId: string;
	score: number;
	/** Whether the voter holds an upvote on this target after the write. */
	myVote: boolean;
	/** `false` on idempotent no-op. */
	changed: boolean;
}

/**
 * The karma-bump capability as Vote consumes it: given recipient and delta
 * (`+1` cast, `-1` retraction), the **unexecuted** statement to include in the
 * cast batch — so the karma adjustment commits atomically with the vote, or
 * not at all.
 */
export interface KarmaBumpService {
	readonly statement: (db: DrizzleDb, userId: string, delta: number) => Stmt;
}

/**
 * The contract Vote OWNS for the karma side-effect of a cast (dependency
 * inversion). Vote is a shared low-level service (Sözlük and Pano both delegate
 * to it), so it must not import a feature directory: it declares what it needs
 * and the implementation arrives at layer composition (pasaport, via
 * `fate/layers.ts`). This is also the swap point for a future DO-backed Künye
 * karma bump — if that can't be expressed as a D1 batch statement, this
 * contract is the thing to renegotiate, not Vote's internals.
 */
export class KarmaBump extends Context.Service<KarmaBump, KarmaBumpService>()(
	"@kampus/vote/KarmaBump",
) {}

/**
 * The voter-eligibility capability as Vote consumes it: given the voter's account id,
 * is that account **above the çaylak newcomer floor** (a promoted/trusted account)?
 * Voting on live content is an earned privilege ("earn to vote", #1810) — a still-newcomer
 * çaylak (or a `visitor`) must be rejected at the single `Vote.castImpl` choke point before
 * any score/karma write.
 *
 * Owned by Vote for the SAME dependency-inversion reason as {@link KarmaBump}: Vote is a
 * shared low-level service that must not import a feature directory, so it declares the
 * boolean predicate it needs and the real tier comparison — the `authorshipLadder`
 * (`visitor < çaylak < yazar`, ADR 0107 §4) read against `Kunye.tierOf` — arrives at layer
 * composition (`fate/layers.ts`). Keeping the tier *vocabulary* at that seam (not in Vote)
 * is what lets the ladder move — a new intermediate rank, or a karma-floor variant — without
 * touching Vote's internals; this contract is the renegotiation point.
 */
export interface VoterStandingService {
	readonly isAboveNewcomer: (voterId: string) => Effect.Effect<boolean>;
}

/** The contract Vote OWNS for the voter-tier gate of a cast (dependency inversion). */
export class VoterStanding extends Context.Service<VoterStanding, VoterStandingService>()(
	"@kampus/vote/VoterStanding",
) {}

export class Vote extends Context.Service<
	Vote,
	{
		/**
		 * Score + credit karma for a vote on a **live** target. Two eligibility gates guard the
		 * write: the *target*-liveness gate rejects a still-sandboxed target with
		 * {@link VoteTargetSandboxed} (sandboxed çaylak content is votable ONLY through
		 * {@link castOnSandboxed}, past the divan gate, #1288); the *voter*-tier gate rejects a
		 * newcomer (çaylak/visitor) voter with {@link VoterNotEligible} — voting on live content
		 * is earned above the çaylak floor ("earn to vote", #1810). This is the surface the inline
		 * sözlük/pano vote paths delegate to, so an inline voter can neither score sandboxed
		 * content nor cast before they are promoted.
		 */
		readonly cast: (
			input: VoteInput,
		) => Effect.Effect<VoteResult, VoteTargetNotFound | VoteTargetSandboxed | VoterNotEligible>;
		/**
		 * The divan-authorized cast (#1288): identical to {@link cast} but ACCEPTS a sandboxed
		 * target. The only caller is the `features/divan` vote mutation, which reaches this
		 * past `requireDivanAccess` (`yield* ViewDivan` — the compile-error gate, ADR 0107);
		 * Vote stays vocabulary-free about the divan, so the authorization lives at that
		 * resolver, not here. Karma + scoring are the SAME atomic batch as `cast` — the vote
		 * writes GLOBAL `user_profile.total_karma` (ADR 0050) and a yazar's and a mod's vote
		 * each weigh `+1` (the divan gate admits both identically).
		 */
		readonly castOnSandboxed: (input: VoteInput) => Effect.Effect<VoteResult, VoteTargetNotFound>;
		/**
		 * Batched `myVote` presence read: the subset of `targetIds` the viewer has
		 * a `user_vote` row for, of the given `kind`, in one `IN (...)` read so
		 * callers stamp `myVote` without an N+1. Missing viewer or empty
		 * `targetIds` short-circuits to an empty Set with no read.
		 */
		readonly readMine: (
			viewerId: string | null | undefined,
			kind: TargetKind,
			targetIds: ReadonlyArray<string>,
		) => Effect.Effect<Set<string>>;
		/**
		 * The single vote-cleanup home for the removal substrate (ADR 0096 §3):
		 * wipe the per-target vote rows (`*_vote`) and the `user_vote` mirror for one
		 * target, in **one** D1 batch (ADR 0014). Karma is **KEPT** — there is no
		 * `total_karma` decrement here, so removing content never reverses the karma
		 * its upvotes earned (sözlük's keep rule, generalized; pano's reversal is
		 * deleted). The caller stamps `Removed` on the content row and recomputes the
		 * summary caches outside this batch (recomputable caches, ADR 0011/0096).
		 */
		readonly clearTarget: (kind: TargetKind, targetId: string) => Effect.Effect<void>;
	}
>()("@kampus/vote/Vote") {}

export const VoteLive = Layer.effect(Vote)(
	Effect.gen(function* () {
		// `orDieAccess`: every internal DB call site dies on `DrizzleError`
		// (infra failures are defects — the domain-boundary rule), so public
		// signatures carry domain errors only and `R` stays `never`.
		const {run, batch} = orDieAccess(yield* Drizzle);
		const karmaBump = yield* KarmaBump;
		const voterStanding = yield* VoterStanding;

		// Per-target metadata lookup. If the row is missing or removed we
		// surface `VoteTargetNotFound` rather than letting the batch fail with
		// an FK-shaped error.
		const loadMeta = Effect.fn("Vote.loadMeta")(function* (kind: TargetKind, targetId: string) {
			const meta = yield* run((db) => targetTable[kind].loadMeta(db, targetId));
			if (!meta) {
				return yield* new VoteTargetNotFound({
					targetKind: kind,
					targetId,
					message: `vote target ${kind} ${targetId} not found`,
				});
			}
			return meta;
		});

		// Idempotency probe: one point-lookup against the vote table to decide
		// if the write would be a no-op, so re-casts/re-retracts stay cheap
		// reads (the `isCast === alreadyCast` path skips the batch).
		const probeExisting = (kind: TargetKind, targetId: string, userId: string) =>
			run((db) => targetTable[kind].probeVote(db, targetId, userId));

		// Read the truth-derived score back from the cache the batch just
		// refreshed; also serves the idempotent path's tail.
		const readCachedScore = (kind: TargetKind, targetId: string) =>
			run((db) => targetTable[kind].readScore(db, targetId));

		// Lives here (not in each consuming feature) because Vote owns the
		// cross-product `user_vote` table. See the `readMine` interface doc.
		const readMine = Effect.fn("Vote.readMine")(function* (
			viewerId: string | null | undefined,
			kind: TargetKind,
			targetIds: ReadonlyArray<string>,
		) {
			if (!viewerId || targetIds.length === 0) return new Set<string>();
			const rows = yield* run((db) =>
				db
					.select({targetId: schema.userVote.targetId})
					.from(schema.userVote)
					.where(
						and(
							eq(schema.userVote.userId, viewerId),
							eq(schema.userVote.targetKind, kind),
							inArray(schema.userVote.targetId, [...targetIds]),
						),
					),
			);
			return new Set(rows.map((r) => r.targetId));
		});

		// Shared cast body carrying the TWO internal eligibility regimes, never exposed — the
		// public surface is two named methods so a caller can't pass the wrong regime:
		//   • `allowSandboxed`   — the *target*-liveness regime: `cast` (false → reject sandboxed)
		//     vs `castOnSandboxed` (true → accept), the divan-authorized path (#1288).
		//   • `requireVoterTier` — the *voter*-tier regime ("earn to vote", #1810): `cast` (true →
		//     a newcomer voter is rejected) vs `castOnSandboxed` (false → exempt: the divan gate
		//     at the resolver already admits only yazar/mod, so re-gating tier here would be
		//     redundant and would wrongly deny a divan-authorized mod).
		// The real authorization for the sandboxed path is the divan gate at the resolver, not
		// these booleans.
		const castImpl = Effect.fn("Vote.castImpl")(function* (
			input: VoteInput,
			allowSandboxed: boolean,
			requireVoterTier: boolean,
		) {
			// Voter-tier gate — the SINGLE choke point for all three inline cast paths (pano
			// post/comment + sözlük definition all reach here via `cast`). Runs before any read
			// of the target so a newcomer's cast is refused loudly (a typed `VoterNotEligible`,
			// wire `VOTE_REQUIRES_YAZAR` — its wire code + `need` tier are single-sourced from
			// `VOTE_REQUIRED_TIER` in `errors.ts`), never a silent no-op. "Above the çaylak floor"
			// is resolved by the `VoterStanding` seam (discharged by Kunye at `fate/layers.ts`), keeping the
			// tier vocabulary out of Vote. Gated on `input.value` (the CAST direction only): a
			// retraction removes influence, never adds it, and a newcomer never cleared the gate
			// to hold a vote worth retracting — so retraction stays open (and the retract
			// mutations' error unions need no `VoterNotEligible` arm).
			if (requireVoterTier && input.value) {
				const eligible = yield* voterStanding.isAboveNewcomer(input.userId);
				if (!eligible) {
					return yield* new VoterNotEligible({
						voterId: input.userId,
						need: VOTE_REQUIRED_TIER,
						message: `voter ${input.userId} is below the vote-eligibility floor (must be promoted above çaylak)`,
					});
				}
			}

			const meta = yield* loadMeta(input.targetKind, input.targetId);

			if (meta.sandboxed && !allowSandboxed) {
				return yield* new VoteTargetSandboxed({
					targetKind: input.targetKind,
					targetId: input.targetId,
					message: `vote target ${input.targetKind} ${input.targetId} is sandboxed`,
				});
			}

			const now = new Date();
			const isCast = input.value;
			const alreadyCast = yield* probeExisting(input.targetKind, input.targetId, input.userId);

			if (isCast === alreadyCast) {
				// State matches intent: no write, return the cached score.
				const score = yield* readCachedScore(input.targetKind, input.targetId);
				return {
					targetKind: input.targetKind,
					targetId: input.targetId,
					authorId: meta.authorId,
					score,
					myVote: alreadyCast,
					changed: false,
				} satisfies VoteResult;
			}

			// State change — see `buildBatchStatements` for the atomic batch.
			const karmaDelta = isCast ? 1 : -1;

			yield* batch((db) =>
				buildBatchStatements(db, input, meta, isCast, karmaDelta, now, karmaBump),
			);

			const newScore = yield* readCachedScore(input.targetKind, input.targetId);

			return {
				targetKind: input.targetKind,
				targetId: input.targetId,
				authorId: meta.authorId,
				score: newScore,
				myVote: isCast,
				changed: true,
			} satisfies VoteResult;
		});

		return {
			readMine,
			// `cast`: reject a sandboxed target AND require the voter be above the çaylak floor.
			cast: (input: VoteInput) => castImpl(input, false, true),
			castOnSandboxed: (input: VoteInput) =>
				// `castImpl` with the sandbox gate open (and the voter-tier gate OFF — the divan
				// resolver already admits only yazar/mod) never surfaces VoteTargetSandboxed or
				// VoterNotEligible, so the divan path's error channel is VoteTargetNotFound only.
				castImpl(input, true, false) as Effect.Effect<VoteResult, VoteTargetNotFound>,
			clearTarget: Effect.fn("Vote.clearTarget")(function* (kind: TargetKind, targetId: string) {
				yield* batch((db) => buildClearTargetStatements(db, kind, targetId));
			}),
		};
	}),
);

/**
 * The two statements clearing one target's votes: the per-target `*_vote` rows
 * and the `user_vote` mirror, no karma touched. `db.batch` commits both or
 * neither (ADR 0014), so a removed entity never carries orphan vote rows.
 */
function buildClearTargetStatements(db: DrizzleDb, kind: TargetKind, targetId: string) {
	return [
		targetTable[kind].clearVotes(db, targetId),
		db
			.delete(schema.userVote)
			.where(and(eq(schema.userVote.targetKind, kind), eq(schema.userVote.targetId, targetId))),
	] as const;
}

/**
 * The tuple of statements making up one atomic state-change, in order:
 * vote-table mutation (truth source), score-cache update, `user_vote` mirror,
 * karma bump. `db.batch([...])` commits all or none. See ADR 0014.
 */
function buildBatchStatements(
	db: DrizzleDb,
	input: VoteInput,
	meta: TargetRecordMeta,
	isCast: boolean,
	karmaDelta: number,
	now: Date,
	karmaBump: KarmaBumpService,
) {
	const table = targetTable[input.targetKind];
	const voteRow = isCast
		? table.voteInsert(db, input.targetId, input.userId, now)
		: table.voteDelete(db, input.targetId, input.userId);

	const scoreUpdate = table.scoreCache(db, input.targetId, now, meta);

	const userVoteRow = isCast
		? db
				.insert(schema.userVote)
				.values({
					userId: input.userId,
					targetKind: input.targetKind,
					targetId: input.targetId,
					createdAt: now,
				})
				.onConflictDoNothing()
		: db
				.delete(schema.userVote)
				.where(
					and(
						eq(schema.userVote.userId, input.userId),
						eq(schema.userVote.targetKind, input.targetKind),
						eq(schema.userVote.targetId, input.targetId),
					),
				);

	const karma = karmaBump.statement(db, meta.authorId, karmaDelta);

	return [voteRow, scoreUpdate, userVoteRow, karma] as const;
}
