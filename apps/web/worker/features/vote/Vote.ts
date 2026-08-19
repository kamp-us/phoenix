/**
 * Vote — the polymorphic vote service for the three targets (`definition`, `post`,
 * `comment`). Up-only: a vote is a pure presence, so down-vote semantics and vote
 * weights are unrepresentable. Every state-changing cast lands all four mutations in
 * one batch that commits or rolls back as a unit (ADR 0014).
 */
import {and, eq, inArray, type SQL} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, type DrizzleDb, orDieAccess, type Stmt} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import type {KarmaEventReason} from "../../db/karma-event.ts";
import type {TargetKind} from "../../db/target-kind.ts";
import {type TargetRecordMeta, targetTable} from "../../db/target-table.ts";
import {TargetId, UserId} from "../../lib/ids.ts";
import {Telemetry} from "../telemetry/Telemetry.ts";
import {
	VOTE_REQUIRED_TIER,
	VoterNotEligible,
	VoteTargetNotFound,
	VoteTargetSandboxed,
} from "./errors.ts";

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
	/** Server-derived author (the karma recipient) — never a client-supplied one. */
	authorId: string;
	score: number;
	myVote: boolean;
	/** `false` on idempotent no-op. */
	changed: boolean;
}

export interface KarmaBumpInput {
	readonly recipientId: string;
	/** Signed: `+1` cast, `-1` retraction. */
	readonly delta: number;
	readonly source: {readonly kind: TargetKind; readonly id: string};
	readonly reason: KarmaEventReason;
	/** Shared with the rest of the cast batch. */
	readonly at: Date;
	/**
	 * Predicate gating BOTH statements, so the karma delta commits only when the vote
	 * write actually changes the row's presence. A duplicate concurrent cast that raced
	 * the idempotency probe bumps zero times, keeping `SUM(karma_event.delta)` reconciled
	 * with `total_karma` (#2552).
	 */
	readonly guard: SQL;
}

/**
 * Returns **unexecuted** statements for the cast batch. Two, never one: a
 * `total_karma` bump can't land without its append-only ledger row (#2592).
 */
export interface KarmaBumpService {
	readonly statements: (db: DrizzleDb, input: KarmaBumpInput) => readonly [Stmt, Stmt];
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
		 * Score + credit karma for a vote on a **live** target — the surface every inline
		 * sözlük/pano vote path delegates to. Sandboxed targets are votable only through
		 * {@link castOnSandboxed} (#1288), and a newcomer voter is rejected: voting is
		 * earned above the çaylak floor (#1810).
		 */
		readonly cast: (
			input: VoteInput,
		) => Effect.Effect<VoteResult, VoteTargetNotFound | VoteTargetSandboxed | VoterNotEligible>;
		/**
		 * The divan-authorized cast (#1288): {@link cast} but ACCEPTS a sandboxed target. Its
		 * only caller is the `features/divan` vote mutation, which reaches it past
		 * `requireDivanAccess` (ADR 0107) — the authorization lives at that resolver, so Vote
		 * stays vocabulary-free about the divan.
		 */
		readonly castOnSandboxed: (input: VoteInput) => Effect.Effect<VoteResult, VoteTargetNotFound>;
		/** The subset of `targetIds` the viewer voted on, in one `IN (...)` read (no N+1). */
		readonly readMine: (
			viewerId: string | null | undefined,
			kind: TargetKind,
			targetIds: ReadonlyArray<string>,
		) => Effect.Effect<Set<string>>;
		/**
		 * The single vote-cleanup home for the removal substrate (ADR 0096 §3). Karma is
		 * deliberately **KEPT**: removing content never reverses the karma its upvotes
		 * earned, so there is no `total_karma` decrement here.
		 */
		readonly clearTarget: (kind: TargetKind, targetId: string) => Effect.Effect<void>;
	}
>()("@kampus/vote/Vote") {}

export const VoteLive = Layer.effect(Vote)(
	Effect.gen(function* () {
		// `orDieAccess`: infra failures die as defects, so the public signatures below
		// carry domain errors only.
		const {run, batch} = orDieAccess(yield* Drizzle);
		const karmaBump = yield* KarmaBump;
		const voterStanding = yield* VoterStanding;
		const telemetry = yield* Telemetry;

		const loadMeta = Effect.fn("Vote.loadMeta")(function* (kind: TargetKind, targetId: string) {
			const meta = yield* run((db) => targetTable[kind].loadMeta(db, targetId));
			if (!meta) {
				return yield* new VoteTargetNotFound({
					targetKind: kind,
					targetId: TargetId.make(targetId),
					message: `vote target ${kind} ${targetId} not found`,
				});
			}
			return meta;
		});

		const probeExisting = (kind: TargetKind, targetId: string, userId: string) =>
			run((db) => targetTable[kind].probeVote(db, targetId, userId));

		const readCachedScore = (kind: TargetKind, targetId: string) =>
			run((db) => targetTable[kind].readScore(db, targetId));

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

		// Both booleans stay private — the public surface is two named methods so a caller
		// can't pass the wrong regime. `requireVoterTier` is OFF for `castOnSandboxed`: the
		// divan gate at the resolver already admits only yazar/mod, and re-gating tier here
		// would wrongly deny a divan-authorized mod.
		const castImpl = Effect.fn("Vote.castImpl")(function* (
			input: VoteInput,
			allowSandboxed: boolean,
			requireVoterTier: boolean,
		) {
			// Deliberately gated on `input.value` — the CAST direction only. A retraction
			// removes influence rather than adding it, and a newcomer never cleared the gate to
			// hold a vote worth retracting, so retraction stays open and the retract mutations'
			// error unions need no `VoterNotEligible` arm.
			if (requireVoterTier && input.value) {
				const eligible = yield* voterStanding.isAboveNewcomer(input.userId);
				if (!eligible) {
					return yield* new VoterNotEligible({
						voterId: UserId.make(input.userId),
						need: VOTE_REQUIRED_TIER,
						message: `voter ${input.userId} is below the vote-eligibility floor (must be promoted above çaylak)`,
					});
				}
			}

			const meta = yield* loadMeta(input.targetKind, input.targetId);

			if (meta.sandboxed && !allowSandboxed) {
				return yield* new VoteTargetSandboxed({
					targetKind: input.targetKind,
					targetId: TargetId.make(input.targetId),
					message: `vote target ${input.targetKind} ${input.targetId} is sandboxed`,
				});
			}

			const now = new Date();
			const isCast = input.value;
			const alreadyCast = yield* probeExisting(input.targetKind, input.targetId, input.userId);

			if (isCast === alreadyCast) {
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

			const karmaDelta = isCast ? 1 : -1;

			yield* batch((db) =>
				buildBatchStatements(db, input, meta, isCast, karmaDelta, now, karmaBump),
			);

			// Emit AFTER the batch commits, so a rolled-back cast emits nothing. Bare on
			// purpose: `TelemetryLive` swallows its whole failure Cause inside the seam
			// (ADR 0153 S4), so wrapping this call site would be redundant.
			yield* telemetry.emit({
				feature: "vote",
				action: isCast ? "cast" : "retract",
				surface: input.targetKind,
				userId: input.userId,
			});

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
			cast: (input: VoteInput) => castImpl(input, false, true),
			castOnSandboxed: (input: VoteInput) =>
				// With both gates off, `castImpl` can surface neither VoteTargetSandboxed nor
				// VoterNotEligible — hence the narrowing cast.
				castImpl(input, true, false) as Effect.Effect<VoteResult, VoteTargetNotFound>,
			clearTarget: Effect.fn("Vote.clearTarget")(function* (kind: TargetKind, targetId: string) {
				yield* batch((db) => buildClearTargetStatements(db, kind, targetId));
			}),
		};
	}),
);

function buildClearTargetStatements(db: DrizzleDb, kind: TargetKind, targetId: string) {
	return [
		targetTable[kind].clearVotes(db, targetId),
		db
			.delete(schema.userVote)
			.where(and(eq(schema.userVote.targetKind, kind), eq(schema.userVote.targetId, targetId))),
	] as const;
}

/**
 * Order is load-bearing: `db.batch` runs the tuple in sequence, so the karma pair must
 * come BEFORE the vote write it credits — its guard reads the row's presence as it was,
 * which is what makes a raced duplicate cast a karma no-op (#2552).
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

	const [karmaBumpRow, karmaEventRow] = karmaBump.statements(db, {
		recipientId: meta.authorId,
		delta: karmaDelta,
		source: {kind: input.targetKind, id: input.targetId},
		reason: isCast ? "vote" : "retract",
		at: now,
		guard: table.voteChangeGuard(db, input.targetId, input.userId, isCast),
	});

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

	return [karmaBumpRow, karmaEventRow, voteRow, scoreUpdate, userVoteRow] as const;
}
