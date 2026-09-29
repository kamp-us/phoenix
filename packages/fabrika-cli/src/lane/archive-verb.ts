/**
 * `lane archive` — move one lane whose log will never replay out of the swept root.
 *
 * The route for a lane no sweep can judge. `lane reconcile` reports such a lane
 * `unreadable` and `lane migrate` refuses it `unsafe` on every run, forever, because the fault is in
 * a log neither may rewrite: an `ISSUE.DONE` appended after the fold reached `frozen` has no update
 * cell and never will. Sealing it would mean appending a line for something that did not happen —
 * the log is append-only and a recorded line is never rewritten — and giving `frozen` the cell
 * would let a lane at its retry cap ship with no unblock. So the lane leaves the sweep's scope by
 * moving, and the log is never touched.
 *
 * **The unreplayable log is the whole entitlement**, and it is what keeps a genuinely broken lane
 * visible: a lane whose log replays is refused with the directory where it was. The archived root is
 * a SIBLING of the swept one, so no sweep learns a skip rule — `reconcile` and `migrate` read the
 * roots they are handed, and the archived one is not among them.
 *
 * **`--retriaged` is the one other entitlement, and it is a separate route rather than a widening.**
 * A lane whose log replays to `diagnosed` with no pull request anywhere in it is a builder's no-PR
 * finish, and that final leaves the key occupied: once triage rewrites the issue, `lane open` has
 * nothing to boot into. Under the flag the lane moves on {@link judgeRetriage}'s verdict alone, every
 * other final is refused on {@link NOT_DIAGNOSED}, and the unreplayable route keeps its own gate
 * untouched. An issue re-triaged twice leaves two such ledgers, so this route takes the first free
 * `<lane>`, `<lane>.archived-<n>` slot rather than refusing on the first; the unreplayable route
 * still refuses an occupied destination.
 *
 * **An open issue is no longer a refusal.** A bricked ledger whose issue is still open had
 * no route at all: repair needs the replay that is broken, `settle` needs a board closure, and the
 * archive's own closed-issue gate refused it — so the seat stayed held and the lane could only be
 * deleted by hand, which is the thing an append-only log exists to prevent. The replay judgement
 * already carries what the closure gate was protecting: a log no machine can fold is a lane nobody
 * can drive, whatever the issue says.
 *
 * **The claim dies with the lane, and this verb kills it.** A lane that leaves the swept root while
 * its issue carries a live `lane-claim` marker strands that issue — the next `lane claim` reads a
 * foreign holder and refuses on a lane that is no longer there. So the marker is retracted here,
 * before the move, and a claim this caller does not name refuses on {@link CLAIM_NOT_MINE} rather
 * than being swept out from under its driver — the guard `lane settle` already holds, one act
 * further on. Ownership is raw token equality against the winning claimant, so a dead seat leaves
 * through `lane adopt` and then `lane release`: adopt mints a successor token beside the standing
 * claim, and release is what deletes the marker. Retract-then-move is the safe order: a retraction that lands over a move that does not
 * leaves an unclaimed lane where it was, which the next run archives; the reverse leaves a claim on
 * a lane nothing can release.
 */
import {Effect, type FileSystem, Path, Result} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type Claimants, readClaimants} from "../build/claim.ts";
import {exists, readFile, rename} from "../io/fs.ts";
import {deleteComment, resolveRepo} from "../io/issues.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {judgeArchive, judgeRetriage} from "./archive.ts";
import {LANE_CLAIM} from "./claim.ts";
import {
	APPEND_UNKNOWN,
	CLAIM_NOT_MINE,
	LANE_EXISTS,
	LANE_UNREADABLE,
	LOG_REPLAYS,
	MARKER_READBACK,
	NOT_DIAGNOSED,
} from "./codes.ts";
import {loadRefusal} from "./refusals.ts";
import {type LaneRef, type LoadedLane, loadLane} from "./store.ts";

const VERB = "fabrika lane archive";

type LoadedLaneRecord = Extract<LoadedLane, {readonly _tag: "Loaded"}>;

export type ClaimsReader<R> = (issue: number) => Effect.Effect<Claimants, never, R>;

/** The retraction of one marker comment. A write that failed is `Failed`, never a silent success. */
export type Retraction =
	| {readonly _tag: "Retracted"}
	| {readonly _tag: "Failed"; readonly reason: string};

export type ClaimRetractor<R> = (
	issue: number,
	commentId: number,
) => Effect.Effect<Retraction, never, R>;

/** Both board seams, resolving the repo once between them, in the shape `lane settle` established. */
export const boardClaimSeams = (
	repo: string | null,
	env: Readonly<Record<string, string | undefined>>,
): {
	readonly claims: ClaimsReader<ChildProcessSpawner.ChildProcessSpawner>;
	readonly retract: ClaimRetractor<ChildProcessSpawner.ChildProcessSpawner>;
} => {
	let resolved: string | null = null;
	const target = Effect.gen(function* () {
		if (resolved !== null) return resolved;
		const attempt = yield* resolveRepo(repo, env);
		if (attempt._tag === "Failure") return null;
		resolved = attempt.value;
		return resolved;
	});
	const unresolved =
		"no target repo resolves — set CLAUDE_PIPELINE_REPO, or pass --repo owner/name";
	return {
		claims: (issue) =>
			Effect.gen(function* () {
				const name = yield* target;
				if (name === null) return {_tag: "Unknown" as const, reason: unresolved};
				return yield* readClaimants(name, issue, LANE_CLAIM);
			}),
		retract: (_issue, commentId) =>
			Effect.gen(function* () {
				const name = yield* target;
				if (name === null) return {_tag: "Failed" as const, reason: unresolved};
				const deleted = yield* deleteComment(name, commentId);
				return deleted._tag === "Failure"
					? {_tag: "Failed" as const, reason: deleted.reason}
					: {_tag: "Retracted" as const};
			}),
	};
};

/** Which entitlement the caller moves this lane on — `--retriaged` picks the second. */
export type ArchiveRoute = "unreplayable" | "retriaged";

/** What the judgement proved the move stands on, carried through to the answer. */
type Entitlement =
	| {
			readonly route: "unreplayable";
			readonly through: "current" | "candidate";
			readonly defects: ReadonlyArray<string>;
	  }
	| {readonly route: "retriaged"; readonly state: string};

type Judged =
	| {readonly _tag: "Entitled"; readonly entitlement: Entitlement}
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

/**
 * How many archived slots one key may take on the re-triage route — `<lane>`, then
 * `<lane>.archived-2` onward. A bound, so a probe that keeps answering "occupied" ends in a refusal
 * rather than a loop; no issue is re-triaged into a lane this many times.
 */
const ARCHIVE_SLOTS = 100;

const slotLeaf = (lane: string, slot: number): string =>
	slot === 1 ? lane : `${lane}.archived-${slot}`;

const refused = (outcome: VerbOutcome): Judged => ({_tag: "Refused", outcome});

const judgeUnreplayable = (
	loaded: LoadedLaneRecord,
	templatePaths: ReadonlyArray<string>,
): Effect.Effect<Judged, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const workflowPath = path.join(loaded.dir, "workflow.json");
		const laneText = yield* Effect.result(readFile(workflowPath));
		if (Result.isFailure(laneText)) {
			return refused(
				refuse(
					LANE_UNREADABLE,
					`${VERB}: cannot re-read ${workflowPath}: ${laneText.failure.reason} — whether this lane replays is UNKNOWN. Nothing was moved.`,
				),
			);
		}
		const templateTexts: string[] = [];
		for (const templatePath of templatePaths) {
			const template = yield* Effect.result(readFile(templatePath));
			if (Result.isFailure(template)) {
				return refused(
					refuse(
						LANE_UNREADABLE,
						`${VERB}: cannot read the committed template at ${templatePath}: ${template.failure.reason} — nothing was moved.`,
					),
				);
			}
			templateTexts.push(template.success);
		}

		const judged = judgeArchive(templateTexts, laneText.success, loaded.lane, loaded.entries);
		if (judged._tag === "Unjudgeable") {
			return refused(
				refuse(
					LANE_UNREADABLE,
					`${VERB}: cannot judge whether ${loaded.logPath} replays: ${judged.reason} — refusing to move over UNKNOWN.`,
				),
			);
		}
		if (judged._tag === "Replays") {
			return refused(
				refuse(
					LOG_REPLAYS,
					`${VERB}: ${loaded.logPath} replays through every machine that exists for this lane, so every sweep can judge it — this is not a lane to move out of their scope. A lane that ended \`diagnosed\` with no pull request, over an issue triage has since rewritten, moves with --retriaged. Nothing was moved.`,
				),
			);
		}
		return {
			_tag: "Entitled",
			entitlement: {route: "unreplayable", through: judged.through, defects: judged.defects},
		};
	});

const judgeRetriaged = (loaded: LoadedLaneRecord): Judged => {
	const judged = judgeRetriage(loaded.lane, loaded.entries);
	switch (judged._tag) {
		case "Diagnosed":
			return {_tag: "Entitled", entitlement: {route: "retriaged", state: judged.state}};
		case "Unreplayable":
			return refused(
				refuse(
					NOT_DIAGNOSED,
					`${VERB}: ${loaded.logPath} does not replay through the lane's own machine (${judged.defects.join("; ")}), so it cannot be proven \`diagnosed\` — drop --retriaged, and the unreplayable route judges it. Nothing was moved.`,
				),
			);
		case "NotDiagnosed":
			return refused(
				refuse(
					NOT_DIAGNOSED,
					`${VERB}: ${loaded.logPath} folds to ${judged.state}, not a diagnosis final — --retriaged moves only a lane that ended \`diagnosed\` with no pull request, and every other final stays where it is. Nothing was moved.`,
				),
			);
		case "Published":
			return refused(
				refuse(
					NOT_DIAGNOSED,
					`${VERB}: ${loaded.logPath} folds to \`diagnosed\` and its log names pull request(s) ${judged.pulls.join(", ")} — --retriaged moves only a lane that published nothing, so its work is never moved out of the record \`lane open\` reads. Nothing was moved.`,
				),
			);
	}
};

export interface ArchiveOptions<R = never> {
	readonly ref: LaneRef;
	/** Which entitlement this move stands on; the unreplayable one unless `--retriaged` names the other. */
	readonly route: ArchiveRoute;
	/** Where the lane moves to — the archived root, which no sweep is handed. */
	readonly archivedRoot: string;
	/** The committed templates this root's lanes may have booted from; the lane's `id` picks. */
	readonly templatePaths: ReadonlyArray<string>;
	/** The issue this lane drives, or `null` for a key that names none — a chore has no claim thread. */
	readonly issue: number | null;
	/** The lane-claim token, when the driver holding this lane is the one archiving it. */
	readonly token: string | null;
	readonly claims: ClaimsReader<R>;
	readonly retract: ClaimRetractor<R>;
}

export const runArchive = <R = never>(
	options: ArchiveOptions<R>,
): Effect.Effect<VerbOutcome, never, R | FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const {ref, issue} = options;

		const loaded = yield* loadLane(ref);
		if (loaded._tag !== "Loaded") return loadRefusal(VERB, loaded);

		const judged =
			options.route === "retriaged"
				? judgeRetriaged(loaded)
				: yield* judgeUnreplayable(loaded, options.templatePaths);
		if (judged._tag === "Refused") return judged.outcome;
		const {entitlement} = judged;

		const retracted: number[] = [];
		if (issue !== null) {
			const claimed = yield* options.claims(issue);
			if (claimed._tag === "Unknown") {
				return refuse(
					LANE_UNREADABLE,
					`${VERB}: cannot establish whether #${issue} carries a live lane claim: ${claimed.reason} — UNKNOWN, never "unclaimed", and nothing was moved.`,
				);
			}
			const holder = claimed.holder;
			if (holder !== null && holder.token !== options.token) {
				return refuse(
					CLAIM_NOT_MINE,
					`${VERB}: #${issue} carries the live lane claim ${holder.token} — archiving retracts that claim, and a lane another driver holds is not one to take out from under it. Pass --token ${holder.token} if that driver is you, or take a dead seat back through succession — \`fabrika lane adopt ${ref.lane} --session ${holder.session} --reason "<why>"\`, then \`fabrika lane release ${ref.lane} --token <the token adopt printed>\`, which deletes the marker — then re-run. Adopt alone does not clear it: it mints a successor token beside the standing claim, so an archive re-run refuses here again. Nothing was moved.`,
				);
			}
			if (holder !== null) {
				// Every marker carrying the holder's token, and the succession that authorized it: an
				// adopt exists only to make one claim releasable, so it does not outlive the claim.
				const ids = [
					...new Set([
						...claimed.claimants
							.filter((claimant) => claimant.token === holder.token)
							.map((claimant) => claimant.commentId),
						...claimed.adopts
							.filter((adopt) => adopt.adopted === holder.session)
							.map((adopt) => adopt.commentId),
					]),
				];
				for (const commentId of ids) {
					const gone = yield* options.retract(issue, commentId);
					if (gone._tag === "Failed") {
						return refuse(
							APPEND_UNKNOWN,
							`${VERB}: the retraction of marker comment ${commentId} on #${issue} failed: ${gone.reason} — whether #${issue} still carries a lane claim is UNKNOWN, and nothing was moved.`,
							retracted.map(
								(done) => `${VERB}: marker comment ${done} was already retracted by this run.`,
							),
						);
					}
					retracted.push(commentId);
				}
			}
		}

		// The unreplayable route keeps its one slot; a re-triaged issue can leave a ledger per triage.
		const slots = entitlement.route === "retriaged" ? ARCHIVE_SLOTS : 1;
		let destination: string | null = null;
		for (let slot = 1; slot <= slots && destination === null; slot += 1) {
			const candidate = path.join(options.archivedRoot, slotLeaf(ref.lane, slot));
			const occupied = yield* Effect.result(exists(candidate));
			if (Result.isFailure(occupied)) {
				return refuse(
					LANE_UNREADABLE,
					`${VERB}: cannot establish whether ${candidate} is already there: ${occupied.failure.reason} — refusing to move over UNKNOWN.`,
				);
			}
			if (!occupied.success) destination = candidate;
		}
		if (destination === null) {
			const first = path.join(options.archivedRoot, ref.lane);
			return refuse(
				LANE_EXISTS,
				slots === 1
					? `${VERB}: ${first} already holds an archived lane — a move onto it would bury a record this verb exists to keep. Nothing was moved.`
					: `${VERB}: ${first} and every one of its ${slots - 1} numbered slots already hold an archived lane — a move onto any of them would bury a record this verb exists to keep. Nothing was moved.`,
			);
		}
		const archivedLeaf = path.basename(destination);

		const moved = yield* Effect.result(rename(loaded.dir, destination));
		if (Result.isFailure(moved)) {
			return refuse(
				APPEND_UNKNOWN,
				`${VERB}: the move of ${loaded.dir} to ${destination} did not land: ${moved.failure.reason} — the lane is NOT archived.`,
			);
		}
		const landed = yield* Effect.result(exists(path.join(destination, "workflow.json")));
		if (Result.isFailure(landed) || !landed.success) {
			return refuse(
				MARKER_READBACK,
				`${VERB}: the move of ${loaded.dir} reported success and ${destination}/workflow.json does not read back — where this lane's record now is needs a human eye before anything else touches it.`,
			);
		}

		const proven =
			entitlement.route === "retriaged"
				? {state: entitlement.state}
				: {through: entitlement.through, defects: entitlement.defects};
		return answer(
			JSON.stringify({
				answer: "archived",
				route: entitlement.route,
				lane: ref.lane,
				issue,
				from: loaded.dir,
				to: destination,
				...proven,
				retracted,
			}),
			[
				entitlement.route === "retriaged"
					? `${VERB}: moved ${loaded.dir} to ${destination}; the log replays to \`${entitlement.state}\` and names no pull request, so the key is free for a fresh lane.`
					: `${VERB}: moved ${loaded.dir} to ${destination}; the log does not replay through the ${entitlement.through === "current" ? "lane's own machine" : "committed template"}.`,
				retracted.length === 0
					? `${VERB}: ${issue === null ? `"${ref.lane}" names no issue, so there was no lane claim to retract` : `#${issue} carried no live lane claim, so there was none to retract`}.`
					: `${VERB}: retracted the lane claim on #${issue} — marker comment(s) ${retracted.join(", ")}. The issue is claimable again, and \`fabrika lane open ${ref.lane}\` decides whether it re-lanes.`,
				`${VERB}: read it back with \`fabrika lane history ${archivedLeaf} --root ${options.archivedRoot}\`.`,
			],
		);
	});
