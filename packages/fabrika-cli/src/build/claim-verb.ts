/**
 * `build claim` / `build confirm` / `build release` — one protocol, three verbs, in one file because
 * splitting them across three is how two of them come to disagree about who holds a lane.
 *
 * The race is detect-then-tiebreak, not a lock: post the marker, **re-read**, and the earliest
 * authorized marker wins. Posting alone only detects a race; the checkpoint read is what resolves it,
 * and a claim that skipped it would let two staggered co-racers both proceed.
 *
 * **A lost race is a proven outcome on its own code, never exit 0.** v1's direct-claim script exited 0
 * on both won and lost and left the routing to prose (`step3-direct-claim.sh:31,40`), and v1's
 * `claim is-mine` fused "proven lost" with "no session id" on exit 1 (`claim/command.ts:57`). Here
 * `15` is proven-foreign only, a missing session id is `1`, and an unreadable marker set is `11`.
 *
 * A loser retracts its **own** marker and nothing else — never another lane's, which is the one write
 * this protocol must never make. Which marker is its own is decided by the whole token: `claim` races
 * under the one it just minted, and `confirm`/`release` under the `--token` that `claim` handed back,
 * so a sibling lane of the same session is a co-racer here rather than the same claimant (#6037).
 *
 * **One LANE leaves at most one marker on a thread** — #5782's fixed point, keyed on the lane rather
 * than the session. `claim` takes an optional `--token`: handed the token it already holds, it reads
 * ownership before writing and answers `won` with that same marker, posting nothing; handed none, it
 * is a fresh lane and races. `release` sweeps every marker carrying THIS lane's token, not merely the
 * winning one, and `claim` answers with `ownership.marker.token` — the token `requireClaim` will read.
 * Without that, N claims left N markers, `claim` printed its own fresh nonce while every other verb
 * read the earliest, and each `release` peeled one off a stack (#5782) — which is how
 * `build branch --resume` cut a branch off a nonce the caller was never shown. Session-scoped, those
 * same rules told a sibling lane it held its neighbour's claim (#6037), so the scope is the lane.
 *
 * The single exception to "a lane retracts only its own marker" is a succession the board attests:
 * `adopt` records that a named session is gone and this lane inherits its claim, and `release` then
 * retracts the claim and the adopt together (ADR 0295). No TTL, no lease, no steal — the successor
 * writes a comment an ACL check reads, exactly like every other authority in this protocol, and the
 * adopt names the inheriting lane by its whole token so succession does not re-widen ownership back
 * to a session.
 *
 * **`claim` runs the admission test before it writes anything; `confirm` and `release` never run it.**
 * The fence decides what may *start* (ADR 0245), so a campaign paused mid-lane must not strand a
 * running lane or block its release. Claiming is the one moment every path goes through — a number
 * handed straight to `claim` passes through no pool — which is why the refusal has teeth here and is
 * advice at the pool.
 *
 * Blockedness rides the same moment but not the same module: ADR 0301 makes the native `blocked_by`
 * graph the one carrier of "do not start this yet", and the gate reading it is composed AFTER the
 * pure axes, since those answer without IO and an out-of-scope number should refuse on the cheaper
 * fact.
 *
 * In repair the number is a **PR**, which carries no home and no audience of its
 * own, so the test runs over the issue that PR serves (#5562) — and when that issue is
 * `type:decision` the audience axis does not bind, because triage routes a decision to
 * `ready-for:human` by default and a repair lane would otherwise fail a fence it had no way to
 * satisfy (#5914). The default is not an exclusion — a decision issue carrying a founder ruling
 * comment is buildable as transcription (ADR 0300) — so the exemption is read off the target being
 * a PR, never off the pairing being impossible.
 */
import {Effect, type FileSystem} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {
	createComment,
	deleteComment,
	getComment,
	type IssueRecord,
	listComments,
} from "../io/issues.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {readBlockedGate} from "./blockedness.ts";
import {
	BUILD_CLAIM,
	type ClaimOverride,
	composeAdoptMarker,
	composeMarker,
	laneCaller,
	markersIn,
	readAdoptMarker,
	readMarkerToken,
	requireCallerToken,
	requireSession,
	resolveOwnership,
} from "./claim.ts";
import {
	BLOCKED,
	CLAIM_NOT_MINE,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {composeToken, nonceOf, parseToken} from "./lane.ts";
import {
	admissionOf,
	admissionRefusal,
	audienceAxisOf,
	type Citation,
	CLAIM_PURPOSES,
	DEFAULT_CLAIM_PURPOSE,
	dispatchScopeLine,
	NO_CITATION,
	NOT_REPAIR,
	parseCitation,
	parseClaimPurpose,
	purposeScopeLine,
	readDispatch,
	scopeSubjectOf,
	typeAxisOf,
	typeScopeLine,
} from "./scope-admission.ts";
import {openIssue, resolveAdmissionSubject, resolveTargetRepo, scannedLine} from "./target.ts";

export interface ClaimOptions {
	readonly number: number;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** A fresh UUID, supplied by the adapter so the token this run mints is deterministic under test. */
	readonly uuid: string;
	/** The marker's human-readable ISO-8601 timestamp. The tiebreak uses GitHub's `created_at`. */
	readonly at: string;
	/** Why this lane claims — `plan` | `gate` | `build`, as typed. Off-enum refuses (#5175). */
	readonly purpose: string;
	/** Why this run claims an issue the admission test refused, or `null` for the ordinary path. */
	readonly override: string | null;
	/** The lane an override is taken for — required with an override, refused without one. */
	readonly overrideLane: string | null;
	/**
	 * The founder ruling comment this build transcribes, or `null` — the type axis's one arm.
	 *
	 * It is not an override and never seats one: an override admits a refusal, while a citation says
	 * the refusal does not apply, because the choosing this issue asked for already happened on the
	 * board (founder ruling on #5879, comment 5335398768).
	 */
	readonly cites: string | null;
	/**
	 * The token this lane ALREADY holds, when it is re-claiming — `null` on a fresh claim.
	 *
	 * It is what makes the idempotent answer expressible per lane: without it, "already mine" could
	 * only be asked of the session, which is exactly the question #6037 proved a lane must not ask.
	 */
	readonly token: string | null;
}

export type ProtocolOptions = Omit<
	ClaimOptions,
	"uuid" | "at" | "purpose" | "override" | "overrideLane" | "cites" | "token"
> & {
	/** The token `build claim` handed this lane — the identity it is asking under (#6037). */
	readonly token: string;
};

const CLAIM = "build claim";

type OverrideRead =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Read"; readonly override: ClaimOverride | null};

/**
 * The override's two required fields, read before anything is written.
 *
 * An override is the fence's escape hatch, and an escape hatch that records nothing is how the fence
 * rots fail-open by convention — so a reason without a lane, a lane without a reason, and a blank
 * either is a usage refusal rather than a claim with a thin trace (#5175).
 */
const readOverride = (reason: string | null, lane: string | null): OverrideRead => {
	const refusal = (message: string): OverrideRead => ({
		_tag: "Refused",
		outcome: refuse(FAILED, `${CLAIM}: ${message}`),
	});
	if (reason === null && lane === null) return {_tag: "Read", override: null};
	if (reason === null) {
		return refusal(
			"--override-lane was given without --override — a lane names no override on its own.",
		);
	}
	if (reason.trim() === "") {
		return refusal(
			"--override was given with an empty reason — an override is recorded or it is not one.",
		);
	}
	if (lane === null || lane.trim() === "") {
		return refusal(
			'--override was given without a lane — pass --override-lane "<lane>" so the escape hatch names who took it.',
		);
	}
	return {_tag: "Read", override: {lane: lane.trim(), reason: reason.trim()}};
};

const preflight = (
	verb: string,
	options: Pick<ClaimOptions, "number" | "repo" | "env">,
): Effect.Effect<
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {
			readonly _tag: "Ready";
			readonly repo: string;
			readonly session: string;
			readonly issue: IssueRecord;
	  },
	never,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const session = requireSession(verb, options.env);
		if (session._tag === "Refused") return {_tag: "Refused" as const, outcome: session.outcome};
		const resolved = yield* resolveTargetRepo(verb, options.repo, options.env);
		if (resolved._tag === "Refused") return {_tag: "Refused" as const, outcome: resolved.outcome};
		const target = yield* openIssue(
			verb,
			resolved.repo,
			options.number,
			(reason) =>
				`${verb}: cannot read #${options.number}: ${reason} — ownership is UNKNOWN, never "unclaimed".`,
		);
		if (target._tag === "Refused") return {_tag: "Refused" as const, outcome: target.outcome};
		return {
			_tag: "Ready" as const,
			repo: resolved.repo,
			session: session.id,
			issue: target.issue,
		};
	});

export const runClaim = (
	options: ClaimOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const purpose = parseClaimPurpose(options.purpose);
		if (purpose === null) {
			return refuse(
				OFF_VOCABULARY,
				`${CLAIM}: --purpose "${options.purpose}" is not one of ${CLAIM_PURPOSES.join(" | ")} — an unrecognised purpose refuses, and never falls back to ${DEFAULT_CLAIM_PURPOSE}.`,
			);
		}
		const overrideRead = readOverride(options.override, options.overrideLane);
		if (overrideRead._tag === "Refused") return overrideRead.outcome;
		const override = overrideRead.override;

		const ready = yield* preflight(CLAIM, options);
		if (ready._tag === "Refused") return ready.outcome;
		const {repo, session} = ready;
		const {number} = options;

		// Already THIS LANE's: answer with the marker that owns it and write nothing. A second marker
		// would leave `claim` printing one nonce while `confirm`/`requireClaim` read the earliest
		// (#5782), and each `release` would then peel one marker off a stack instead of clearing it.
		// Only a caller that named its own token can be answered this way — a same-session marker under
		// another nonce belongs to a sibling lane, and races below like any other (#6037). The fence is
		// not re-run for the same reason `confirm` and `release` never run it — it decides what may
		// START, and this lane already started.
		if (options.token !== null) {
			const holding = requireCallerToken(CLAIM, session, options.token);
			if (holding._tag === "Refused") return holding.outcome;
			const prior = yield* resolveOwnership(repo, number, holding.caller);
			if (prior.ownership._tag === "Mine" && prior.ownership.adopt !== null) {
				// Answering `won` here would hand back the DEAD session's token — the winner on an adopted
				// claim — and `confirm --token` refuses that token as another session's. This is the only
				// arm that can see it: the post-write read runs under a nonce no adopt can name, so a
				// tokenless claim resolves `Foreign` and loses. Nothing was written, so nothing to retract.
				return refuse(
					CLAIM_NOT_MINE,
					`${CLAIM}: #${number} still carries the adopted claim ${prior.ownership.marker.token} — run "fabrika build release ${number} --token ${prior.ownership.adopt.token}" to retract it and the adopt together, then claim.`,
				);
			}
			if (prior.ownership._tag === "Mine") {
				return answer(
					JSON.stringify({answer: "won", number, token: prior.ownership.marker.token, purpose}),
					[
						`${CLAIM}: #${number} is already held by this lane (comment ${prior.ownership.marker.commentId}) — answered with the marker that owns it; nothing was written.`,
					],
				);
			}
		}

		const read = yield* readDispatch();
		if (read._tag === "Unreadable") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${CLAIM}: cannot read the "## Campaigns" table: ${read.reason} — scope is UNKNOWN, never admitted; nothing was written.`,
			);
		}
		const scopeLine = dispatchScopeLine(CLAIM, read.dispatch);
		const subject = yield* resolveAdmissionSubject(CLAIM, repo, read.dispatch, ready.issue);
		const judged = subject._tag === "Judged" ? subject.facts : ready.issue;
		const repair = subject._tag === "Judged" ? subject.repair : NOT_REPAIR;
		const purposeLine = purposeScopeLine(CLAIM, purpose, audienceAxisOf(judged), repair);
		// The citation is read against the issue the fence actually judges, so a URL naming some other
		// thread cannot open the arm. A value that does not parse refuses here, before any marker: a
		// citation is the whole authority for building a decision, and a broken one confers nothing.
		let citation: Citation = NO_CITATION;
		if (options.cites !== null) {
			const cited = parseCitation(options.cites, repo, judged.number);
			if (cited._tag === "Malformed") {
				return refuse(FAILED, `${CLAIM}: --cites ${cited.reason}; nothing was written.`);
			}
			citation = cited.citation;
		}
		const admission =
			subject._tag === "Judged"
				? admissionOf(read.dispatch, subject.facts, purpose, repair, citation)
				: subject.admission;
		const typeLine = typeScopeLine(CLAIM, typeAxisOf(judged), citation);
		const lines = [
			scopeLine,
			...(subject._tag === "Judged" && subject.note !== null ? [subject.note] : []),
			...(typeLine === null ? [] : [typeLine]),
			purposeLine,
		];
		const refusal = admissionRefusal(CLAIM, admission);
		// An override answers a PROVEN refusal. UNKNOWN has proven nothing, so there is nothing to
		// override — a fence that could not read its input must not be talked past by a flag.
		const overridable =
			admission._tag === "OutOfScope" ||
			admission._tag === "AudienceNotAgent" ||
			admission._tag === "NoServedIssue";
		if (refusal !== null && !(overridable && override !== null)) {
			return {
				...refusal,
				stderr: [
					...lines,
					...refusal.stderr,
					`${CLAIM}: nothing was written — #${number} carries no marker from this run${
						overridable
							? '; pass --override "<reason>" --override-lane "<lane>" to claim it anyway'
							: ""
					}.`,
				],
			};
		}

		// The blockedness gate, ordered AFTER the pure axes because they answer without IO: a number
		// out of scope should be refused on the fact that cost no call (ADR 0301). It runs over the
		// named target only when that target is an issue — a repair claim names a pull request, which
		// carries no edges of its own, and a lane repairing an open PR has already started.
		const gateNotes: string[] = [];
		if (scopeSubjectOf(ready.issue)._tag === "Own") {
			const gate = yield* readBlockedGate(repo, number);
			if (gate._tag === "Unknown") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${CLAIM}: cannot read the blocked_by edges of #${number}: ${gate.reason} — blockedness is UNKNOWN, never "not blocked"; nothing was written.`,
					lines,
				);
			}
			if (gate._tag === "Blocked") {
				return refuse(
					BLOCKED,
					`${CLAIM}: blocked by ${gate.open.length} open blocked_by edge${
						gate.open.length === 1 ? "" : "s"
					}: ${gate.open.map((blocker) => `#${blocker}`).join(", ")} — there is no unblock act, so the edge clears when the blocker closes; nothing was written.`,
					[...lines, scannedLine(CLAIM, gate.scanned, "blocked_by edge")],
				);
			}
			gateNotes.push(scannedLine(CLAIM, gate.scanned, "blocked_by edge", "none open"));
		}

		const token = composeToken(session, options.uuid);
		const nonce = nonceOf(token);
		if (nonce === null) {
			return refuse(
				FAILED,
				`${CLAIM}: the token this run mints, ${token}, yields no lane nonce — nothing was written.`,
			);
		}
		const body = composeMarker(token, options.at, override);
		const posted = yield* createComment(repo, number, body);
		if (posted._tag === "Failure") {
			// The minted token is the ONLY thing that can still address a marker this write may have
			// landed: `confirm` and `release` both require it, so a refusal that withholds it strands
			// the lane in the one state the protocol calls UNKNOWN.
			return refuse(
				WRITE_UNKNOWN,
				`${CLAIM}: the marker write failed: ${posted.reason} — the claim state is UNKNOWN; run "fabrika build confirm ${number} --token ${token}" before any further action.`,
				[
					`${CLAIM}: the token this run minted is ${token} — it addresses the marker the failed write may still have landed. Do not re-run "fabrika build claim ${number}": it mints a second token, and if the first marker landed the race resolves to that earlier one, leaving a claim no lane holds a token for.`,
				],
			);
		}
		const back = yield* getComment(repo, posted.value.id);
		if (back._tag === "Failure" || readMarkerToken(normalizeForReadback(back.value)) !== token) {
			return refuse(
				READBACK_MISMATCH,
				`${CLAIM}: the marker landed but the read-back does not match — the claim needs a human eye.`,
				[`${CLAIM}: comment ${posted.value.id} on #${number} is the one to inspect.`],
			);
		}

		// The checkpoint: posting DETECTS a race, this re-read RESOLVES it. It resolves against the token
		// this run just minted, so a sibling lane of the same session is a co-racer like any other.
		const {ownership, unauthorized} = yield* resolveOwnership(
			repo,
			number,
			laneCaller(session, nonce, token),
		);
		const notes = [
			...lines,
			...gateNotes,
			...unauthorized.map(
				(marker) =>
					`${CLAIM}: comment ${marker.commentId} carries a claim marker from "${marker.author}", who holds no write permission — counted, never a winner.`,
			),
		];
		if (ownership._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${CLAIM}: cannot read the claim markers on #${number}: ${ownership.reason} — ownership is UNKNOWN, never "unclaimed".`,
				notes,
			);
		}
		if (ownership._tag === "Mine" && ownership.adopt === null) {
			// The winner is the marker this run just posted: `Mine` turns on the whole token, so an older
			// marker of this session under another nonce is a SIBLING lane and lands on the lose path
			// below, where this run retracts its OWN marker. That is what keeps #5782's fixed point —
			// one marker per lane on the thread — without the session-scoped retraction it shipped with.
			return answer(
				JSON.stringify({
					answer: "won",
					number,
					// The marker's token, not the minted one: they are equal here by construction, and the
					// one that holds the lane is the one a caller may derive a nonce from (#6037).
					token: ownership.marker.token,
					purpose,
					...(override === null ? {} : {override}),
					...(citation._tag === "Cited" ? {cites: citation.url} : {}),
				}),
				notes,
			);
		}
		// An adopted claim cannot reach here as `Mine`: succession turns on the whole token, and this
		// read runs under the nonce this run just minted, which no adopt on the board can name. It
		// resolves `Foreign` on the dead session's winning marker and takes the lose path below, which
		// retracts this run's own marker — so the succession leaves no orphan either way.

		// Lost, or shadowed by an unauthorized-only thread: retract this run's OWN marker, nothing else.
		const retracted = yield* deleteComment(repo, posted.value.id);
		const trailer =
			retracted._tag === "Failure"
				? [
						`${CLAIM}: could not retract this run's own marker (comment ${posted.value.id}): ${retracted.reason}.`,
					]
				: [`${CLAIM}: retracted this run's own marker (comment ${posted.value.id}).`];
		// Anything holding a winning marker that is not this run's is a loss, whatever resolved it —
		// `Unclaimed` is the only remaining tag, and it means this run's OWN marker is the unauthorized one.
		return ownership._tag !== "Unclaimed"
			? refuse(
					CLAIM_NOT_MINE,
					`${CLAIM}: lost to ${ownership.marker.token} (posted ${ownership.marker.createdAt}, authorized).`,
					[...notes, ...trailer],
				)
			: refuse(
					CLAIM_NOT_MINE,
					`${CLAIM}: this run's own marker is not authorized — its author holds no write permission, so it can never win (ADR 0055).`,
					[...notes, ...trailer],
				);
	});

const CONFIRM = "build confirm";

export const runConfirm = (
	options: ProtocolOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const ready = yield* preflight(CONFIRM, options);
		if (ready._tag === "Refused") return ready.outcome;
		const {repo, session} = ready;
		const {number} = options;

		const asking = requireCallerToken(CONFIRM, session, options.token);
		if (asking._tag === "Refused") return asking.outcome;

		const {ownership, unauthorized} = yield* resolveOwnership(repo, number, asking.caller);
		const notes = unauthorized.map(
			(marker) =>
				`${CONFIRM}: comment ${marker.commentId} carries a claim marker from "${marker.author}", who holds no write permission — counted, never a winner.`,
		);
		switch (ownership._tag) {
			case "Unknown":
				return refuse(
					PRECONDITION_UNKNOWN,
					`${CONFIRM}: cannot read the claim markers on #${number}: ${ownership.reason} — ownership is UNKNOWN, never "unclaimed".`,
					notes,
				);
			case "Unclaimed":
				return refuse(
					CLAIM_NOT_MINE,
					`${CONFIRM}: no claim exists on #${number} — nothing to confirm; run "fabrika build claim ${number}" first.`,
					notes,
				);
			case "Foreign":
				return refuse(
					CLAIM_NOT_MINE,
					`${CONFIRM}: #${number} is held by ${ownership.marker.token}, not by ${options.token.trim()}${
						ownership.sameSession ? " — another lane of this same session" : ""
					}.`,
					notes,
				);
			case "Mine":
				// On a succession the winning marker is the DEAD session's, and `requireCallerToken`
				// refuses that token on `1` for every verb of this session — so the answer is the adopt's
				// token, which is this lane's own and is what `branch`/`scratch`/`tree --issue` key on.
				return answer(
					JSON.stringify({
						answer: "mine",
						number,
						token: ownership.adopt?.token ?? ownership.marker.token,
					}),
					notes,
				);
		}
	});

const RELEASE = "build release";

export const runRelease = (
	options: ProtocolOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const ready = yield* preflight(RELEASE, options);
		if (ready._tag === "Refused") return ready.outcome;
		const {repo, session} = ready;
		const {number} = options;

		const asking = requireCallerToken(RELEASE, session, options.token);
		if (asking._tag === "Refused") return asking.outcome;

		const {ownership, unauthorized, unauthorizedAdopts} = yield* resolveOwnership(
			repo,
			number,
			asking.caller,
		);
		const notes = [
			...unauthorized.map(
				(marker) =>
					`${RELEASE}: comment ${marker.commentId} carries a claim marker from "${marker.author}", who holds no write permission — counted, never a winner.`,
			),
			...unauthorizedAdopts.map(
				(marker) =>
					`${RELEASE}: comment ${marker.commentId} carries an adopt marker from "${marker.author}", who holds no write permission — counted, never a succession.`,
			),
		];
		if (ownership._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${RELEASE}: cannot read the claim markers on #${number}: ${ownership.reason} — ownership is UNKNOWN, never "unclaimed".`,
				notes,
			);
		}
		if (ownership._tag !== "Mine") {
			return refuse(
				CLAIM_NOT_MINE,
				`${RELEASE}: this lane holds no claim on #${number} — refusing to release another lane's.`,
				[
					...notes,
					...(ownership._tag === "Foreign" && !ownership.sameSession
						? [
								`${RELEASE}: #${number} is held by ${ownership.marker.token}; if that session is gone, adopt it first: fabrika build adopt ${number} --session <its session id> --reason <why>, then release under the token that adopt prints.`,
							]
						: []),
				],
			);
		}
		// Every marker carrying THIS LANE's token, not only the winner. A thread carrying duplicates —
		// a write that landed after it reported UNKNOWN, then re-posted — would otherwise hand the next
		// `confirm` the next-oldest one, so release/confirm would have no fixed point (#5782). The
		// filter is the lane's token, never its session: a sibling lane's marker is another lane's
		// claim, and sweeping it is the one write this protocol must never make (#6037).
		const lane = asking.caller;
		const listed = yield* listComments(repo, number);
		if (listed._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${RELEASE}: cannot re-read the markers on #${number}: ${listed.reason} — nothing was retracted; run "fabrika build release ${number} --token ${options.token.trim()}" again.`,
				notes,
			);
		}
		const ids = new Set([
			ownership.marker.commentId,
			...markersIn(listed.value)
				.filter(
					(held) =>
						parseToken(held.token, BUILD_CLAIM.prefix)?.session === lane.session &&
						nonceOf(held.token, BUILD_CLAIM.prefix) === lane.nonce,
				)
				.map((held) => held.commentId),
		]);
		for (const id of ids) {
			const deleted = yield* deleteComment(repo, id);
			if (deleted._tag === "Failure") {
				return refuse(
					WRITE_UNKNOWN,
					`${RELEASE}: the retraction failed: ${deleted.reason} — whether the claim is still held is UNKNOWN; run "fabrika build confirm ${number} --token ${options.token.trim()}".`,
					notes,
				);
			}
		}
		const adopt = ownership.adopt;
		if (adopt === null) return answer(JSON.stringify({answer: "released", number}), notes);
		// The adopt outlives nothing: it exists to authorize this release, so it goes with the claim.
		const cleared = yield* deleteComment(repo, adopt.commentId);
		return cleared._tag === "Failure"
			? refuse(
					WRITE_UNKNOWN,
					`${RELEASE}: the claim was retracted and its adopt marker (comment ${adopt.commentId}) was not: ${cleared.reason} — delete it by hand, or a later claim on #${number} reads a succession that no longer applies.`,
					notes,
				)
			: answer(JSON.stringify({answer: "released", number, adopted: adopt.adopted}), notes);
	});

const ADOPT = "build adopt";

/**
 * `adopt` takes no `--token`: it MINTS the lane identity the succession creates and prints it, which
 * is why it is the one protocol verb not built on `ProtocolOptions`. A successor holds no token on a
 * number whose claim it is inheriting — demanding one would be demanding the thing being conferred.
 */
export interface AdoptOptions extends Omit<ProtocolOptions, "token"> {
	/** The dead session whose claim this run adopts. */
	readonly session: string;
	/** Why the succession is taken — required, and recorded on the marker. */
	readonly reason: string;
	/** A fresh UUID, supplied by the adapter so the successor token is deterministic under test. */
	readonly uuid: string;
	readonly at: string;
}

/**
 * `build adopt` — the successor driver names a dead session on the board, so its stranded claim
 * becomes releasable (ADR 0295).
 *
 * It writes one comment and nothing else. It takes no claim, evicts nobody, and confers ownership
 * only on the session it names as successor: the release that follows still runs the ordinary
 * ownership read, so an adopt posted by an account below `write` decides nothing.
 */
export const runAdopt = (
	options: AdoptOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const adopted = options.session.trim();
		const reason = options.reason.trim();
		if (adopted === "") {
			return refuse(
				FAILED,
				`${ADOPT}: --session is empty — an adoption that names no session adopts nothing.`,
			);
		}
		if (reason === "") {
			return refuse(
				FAILED,
				`${ADOPT}: --reason is empty — a succession is recorded or it is not one.`,
			);
		}
		// The marker is one line with `·` as its field separator, so a value carrying either composes
		// a comment the reader cannot read back: the post lands, the read-back refuses, and a stray
		// comment is left behind. Refuse before the write instead.
		if (/[\s·]/.test(adopted)) {
			return refuse(
				FAILED,
				`${ADOPT}: --session "${adopted}" carries whitespace or "·" — a session id is one unbroken word, and this one would compose a marker no reader can read back; nothing was written.`,
			);
		}
		if (/[\r\n]/.test(reason)) {
			return refuse(
				FAILED,
				`${ADOPT}: --reason spans more than one line — the marker records one line, so the rest would be dropped silently; restate it as one line. Nothing was written.`,
			);
		}

		const ready = yield* preflight(ADOPT, options);
		if (ready._tag === "Refused") return ready.outcome;
		const {repo, session} = ready;
		const {number} = options;

		if (adopted === session) {
			return refuse(
				FAILED,
				`${ADOPT}: --session names this very session — "fabrika build release ${number}" already covers a claim this session holds; nothing was written.`,
			);
		}

		const token = composeToken(session, options.uuid);
		const body = composeAdoptMarker(adopted, token, options.at, reason);
		const posted = yield* createComment(repo, number, body);
		if (posted._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${ADOPT}: the adopt marker write failed: ${posted.reason} — whether the succession is recorded is UNKNOWN; re-read #${number}'s comments before releasing.`,
			);
		}
		const back = yield* getComment(repo, posted.value.id);
		const read = back._tag === "Failure" ? null : readAdoptMarker(normalizeForReadback(back.value));
		if (read === null || read.adopted !== adopted || read.token !== token) {
			return refuse(
				READBACK_MISMATCH,
				`${ADOPT}: the adopt marker landed but the read-back does not match — the succession needs a human eye.`,
				[`${ADOPT}: comment ${posted.value.id} on #${number} is the one to inspect.`],
			);
		}
		return answer(JSON.stringify({answer: "adopted", number, session: adopted, token}), [
			`${ADOPT}: #${number}'s claim from "${adopted}" is now releasable by the lane this marker names — run "fabrika build release ${number} --token ${token}".`,
		]);
	});
