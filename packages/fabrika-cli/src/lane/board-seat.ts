/**
 * The board seat — the one arm out of `lane open`'s prior-lane refusal (exit 63), and what the board
 * has to prove before it opens.
 *
 * A ledger is a lane's whole state and `.fabrika/` is gitignored, so a lane driven on another
 * operator's machine leaves this checkout nothing to resume. The refusal is right that re-booting
 * over it would launder a spent repair budget, and it had no arm at all for the one case where the
 * prior ledger is unreachable forever: a successor driver holding a verified pull request ended with
 * no verb that moved it.
 *
 * **What this module adds is a seat the board proves, not a way past the guard.** Two halves, and
 * they are separate on purpose:
 *
 * - **Admission is the merge gate's own bar.** Exactly one pull request hangs off the issue, and
 *   every namespace its head derives has answered — the same {@link foldNamespaces} fold `lane prove`
 *   takes for a `PASS`. A standing `FAIL` means a repair round is owed and nothing here can say how
 *   many the prior lane already spent, so it stays refused; so does a verdict that no longer binds
 *   the head, an unread board, and several pull requests.
 * - **The budget is seated at zero whatever the board said.** The board proves the work is verified;
 *   it proves nothing about how many repair rounds the prior lane burned. So the placed document
 *   declares `maxRetries: 0` — a `FAIL` on this lane parks at `human:budget-spent` immediately, and
 *   a round comes back the one way it always did, through a grant recorded on the board.
 *
 * The seat is read through a caller-passed reader, the shape [`prior-lane.ts`](prior-lane.ts)
 * established, so `lane open`'s unit tier stays offline. An unreadable half is `Unknown`, never a
 * seat: reading a failed read as "verified" is the permissive arm the whole refusal exists to close.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9435#issuecomment-5752589286
 */
import {Effect, type FileSystem, type Path} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {governedRootsOr, uiSurfacesOr} from "../config/paths.ts";
import {newestRulingAt} from "../decision/ruling.ts";
import {standingRulings} from "../decision/standing-rulings.ts";
import {createComment, resolveRepo} from "../io/issues.ts";
import {isRecord, parseJson} from "../io/json.ts";
import {getPullRequest} from "../io/pulls.ts";
import {foldNamespaces, type Proof} from "./prove.ts";
import {readNamespaceRows} from "./prove-verb.ts";

const VERB = "fabrika lane open --from-board";

export type BoardSeat =
	/** The board proves this pull request is verified at `head` — the lane may be seated. */
	| {readonly _tag: "Seatable"; readonly pr: number; readonly head: string; readonly note: string}
	/** The board was read in full and does not prove it — the prior-lane refusal stands. */
	| {readonly _tag: "Unproven"; readonly why: string}
	/** A read failed, so the seat is UNKNOWN — never a seat, and never a fresh lane either. */
	| {readonly _tag: "Unknown"; readonly reason: string};

export type BoardSeatReader<R> = (
	issue: number,
	pulls: ReadonlyArray<number>,
) => Effect.Effect<BoardSeat, never, R>;

export type BoardRecord =
	| {readonly _tag: "Recorded"; readonly url: string}
	| {readonly _tag: "Unrecorded"; readonly reason: string};

/** Writes the adoption onto the issue — the record that makes this boot reviewable afterwards. */
export type BoardRecorder<R> = (
	issue: number,
	body: string,
) => Effect.Effect<BoardRecord, never, R>;

/**
 * The one pull request a seat may stand on, or the reason none does.
 *
 * Several is its own answer for the reason `prove.ts`'s pull trace keeps one: which one the prior lane drove is not
 * derivable here, and seating against the first would seat a lane on another lane's verdicts.
 */
export const solePull = (
	pulls: ReadonlyArray<number>,
):
	| {readonly _tag: "One"; readonly pr: number}
	| {readonly _tag: "Unproven"; readonly why: string} => {
	const [first, ...rest] = pulls;
	if (first === undefined) {
		return {
			_tag: "Unproven",
			why: "the board hangs no pull request off it, so there is no seat to derive",
		};
	}
	return rest.length === 0
		? {_tag: "One", pr: first}
		: {
				_tag: "Unproven",
				why: `the board hangs ${pulls.map((pull) => `#${pull}`).join(", ")} off it, and which one the prior lane drove is not derivable — drive the pull request itself`,
			};
};

/**
 * The seat one pull request's own namespace fold earns.
 *
 * Every refusal keeps the fold's words, because they are what say which half is missing: a
 * contradiction is a repair this lane cannot budget for, an in-flight row is a review nobody
 * finished, and neither is a seat to soften.
 */
export const seatFromProof = (pr: number, head: string, proof: Proof): BoardSeat => {
	if (proof._tag === "Proven") {
		return {_tag: "Seatable", pr, head, note: proof.note};
	}
	if (proof._tag === "Contradicted") {
		return {
			_tag: "Unproven",
			why: `${proof.what} — a repair round is owed, and how many the prior lane already spent is exactly what no read here can prove`,
		};
	}
	return {_tag: "Unproven", why: proof.what};
};

export type BudgetSeed =
	| {readonly _tag: "Spent"; readonly text: string}
	| {readonly _tag: "Unseedable"; readonly reason: string};

/**
 * Declare every task's repair budget spent in the document about to be placed.
 *
 * `maxRetries` is the field, and it is the only one the compiler reads: `machine.ts` seats `retries`
 * at `0` from the log's own prefix whatever a document declares, so writing a spent *counter* would
 * place a lane at a full budget while reading as an exhausted one. Zero declared means the first
 * `FAIL` takes the `human:budget-spent` arm, and `lane clear` raises it by exactly the round it
 * records.
 */
export const spendBudget = (text: string): BudgetSeed => {
	const document = parseJson(text);
	if (!isRecord(document)) return {_tag: "Unseedable", reason: "the document is not JSON"};
	const machine = document.machine;
	if (!isRecord(machine) || !isRecord(machine.context)) {
		return {_tag: "Unseedable", reason: "the document carries no `machine.context` object"};
	}
	const tasks = Object.keys(machine.context);
	if (tasks.length === 0) {
		return {_tag: "Unseedable", reason: "the document's `machine.context` declares no task"};
	}
	const context = Object.fromEntries(
		tasks.map((task) => {
			const seat = (machine.context as Record<string, unknown>)[task];
			return [task, {...(isRecord(seat) ? seat : {}), maxRetries: 0}];
		}),
	);
	return {
		_tag: "Spent",
		text: `${JSON.stringify({...document, machine: {...machine, context}}, null, "\t")}\n`,
	};
};

/**
 * The comment this boot lands on the issue — the record that makes the succession reviewable.
 *
 * It names the pull request and the head the admission stood on, so a reader can re-take the same
 * read, and it states the seated budget, because that is the fact a reader would otherwise have to
 * infer from a gitignored document. It names no path: the ledger is machine-local, and a local path
 * in a board artifact is a leak.
 */
export const adoptionRecord = (issue: number, pr: number, head: string): string =>
	[
		`<!-- fabrika-lane-from-board issue=${issue} pr=${pr} head=${head} -->`,
		"## Lane seated from the board",
		"",
		`The ledger that drove #${pr} is not reachable from the checkout driving #${issue} now, so a`,
		"successor driver booted a fresh one with `fabrika lane open --from-board`. The board is what",
		`admitted it: #${pr} is open and every namespace its head at \`${head}\` derives has answered.`,
		"",
		"**The new ledger carries no repair budget.** Nothing here proves how many repair rounds the",
		"prior lane spent, so the seat declares zero: a FAIL on this lane parks at `human:budget-spent`",
		"at once, and a round comes back only through a grant recorded on the board (`lane clear`).",
	].join("\n");

/**
 * What a refusal below the adoption record owes the reader, or nothing when no record was written.
 *
 * The record lands before the placement because a seat nobody can review is the laundering this arm
 * exists not to be — which means every refusal past that write leaves a comment on the board claiming
 * a succession that has no ledger behind it. Nothing retracts it: the boot has no authority to edit
 * the board back, and a re-run posts a second record beside the first. So the refusal names it, the
 * way every other refusal in this verb names exactly what it did and did not write.
 */
export const strandedRecord = (record: string | null): ReadonlyArray<string> =>
	record === null
		? []
		: [
				`The adoption record at ${record} is already on the board and nothing here retracts it, so it now names a lane that was not booted — re-running posts a second record beside it.`,
			];

/**
 * The live reader: one pull request, open, with every namespace its head derives answered.
 *
 * The verdict read is `lane prove`'s own ({@link readNamespaceRows}) rather than a second reading of
 * it, so the bar this boot clears cannot drift from the bar the `PASS` it is standing in for had to
 * clear. Nothing is deferred — a seat stands on the whole derived set, because there is no later
 * cell of this lane left to owe one.
 */
export const boardSeatReader =
	(
		repo: string | null,
		cwd: string,
		env: Readonly<Record<string, string | undefined>>,
	): BoardSeatReader<
		| ChildProcessSpawner.ChildProcessSpawner
		| HttpClient.HttpClient
		| FileSystem.FileSystem
		| Path.Path
	> =>
	(issue, pulls) =>
		Effect.gen(function* () {
			const sole = solePull(pulls);
			if (sole._tag === "Unproven") return sole;
			const pr = sole.pr;

			const resolved = yield* resolveRepo(repo, env);
			if (resolved._tag === "Failure") {
				return {
					_tag: "Unknown" as const,
					reason: "no target repo resolves — set CLAUDE_PIPELINE_REPO, or pass --repo owner/name",
				};
			}
			const target = resolved.value;

			const pull = yield* getPullRequest(target, pr);
			if (pull._tag === "Unknown") {
				return {_tag: "Unknown" as const, reason: `cannot read #${pr}: ${pull.reason}`};
			}
			if (pull._tag === "Absent") {
				return {_tag: "Unproven" as const, why: `#${pr} is not there to be verified`};
			}
			if (pull.value.merged || pull.value.state !== "open") {
				return {
					_tag: "Unproven" as const,
					why: `#${pr} is ${pull.value.merged ? "merged" : "closed"}, so there is no owed stage for a lane to be seated at`,
				};
			}

			const governed = yield* governedRootsOr(
				VERB,
				cwd,
				"the required namespace set is UNKNOWN, and a set short one namespace would seat a lane nobody gated.",
			);
			if (governed._tag === "Refused") {
				return {_tag: "Unknown" as const, reason: governed.message};
			}
			const surfaces = yield* uiSurfacesOr(
				VERB,
				cwd,
				"the required namespace set is UNKNOWN, and a set short one namespace would seat a lane nobody gated.",
			);
			if (surfaces._tag === "Refused") {
				return {_tag: "Unknown" as const, reason: surfaces.message};
			}

			const ruled = yield* standingRulings(target, issue);
			if (ruled._tag === "Unknown") {
				return {
					_tag: "Unknown" as const,
					reason: `${ruled.reason} — whether #${pr}'s verdicts still grade this contract is UNKNOWN, never proven`,
				};
			}

			const read = yield* readNamespaceRows(
				target,
				pr,
				[],
				governed.roots,
				surfaces.prefixes,
				[],
				newestRulingAt(ruled.scan),
			);
			if (read._tag === "Unread") {
				return {_tag: "Unknown" as const, reason: `cannot read ${read.what}: ${read.reason}`};
			}
			if (read._tag === "Gone") return {_tag: "Unproven" as const, why: read.what};
			// Nothing is deferred on this path, so the head derives no cell to defer to and this arm is
			// unreachable — it is folded to UNKNOWN rather than read as a seat.
			if (read._tag === "Underived") {
				return {_tag: "Unknown" as const, reason: `#${pr} at ${read.head} derived no required set`};
			}
			return seatFromProof(pr, read.head, foldNamespaces(read.rows, `#${pr}`));
		});

/** The live recorder: the adoption comment, posted on the issue through the ordinary write path. */
export const boardRecorder =
	(
		repo: string | null,
		env: Readonly<Record<string, string | undefined>>,
	): BoardRecorder<ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient> =>
	(issue, body) =>
		Effect.gen(function* () {
			const resolved = yield* resolveRepo(repo, env);
			if (resolved._tag === "Failure") {
				return {
					_tag: "Unrecorded" as const,
					reason: "no target repo resolves — set CLAUDE_PIPELINE_REPO, or pass --repo owner/name",
				};
			}
			const posted = yield* createComment(resolved.value, issue, body);
			return posted._tag === "Failure"
				? ({_tag: "Unrecorded", reason: posted.reason} as const)
				: ({_tag: "Recorded", url: posted.value.url} as const);
		});
