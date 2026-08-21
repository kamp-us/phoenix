/**
 * `build retire` — take back the checkout an orphaned build worktree is holding, when the board
 * licenses it.
 *
 * The residue this clears is #6610: a session dies mid-round, its worktree stays registered holding
 * the lane branch, and `build branch --resume-lane` then refuses on `11` rather than rename the
 * branch out from under a live checkout. Nothing inside the loop could clear it, so every such round
 * ended as a human park on a cleanup carrying no judgment.
 *
 * The order is the contract:
 *
 *   1. `git worktree prune` drops registrations whose directory is already gone.
 *   2. The worktrees holding this number's lane branches are read (`./git.ts`), and the tree this
 *      process is standing in is excluded — a checkout cannot be pulled out from under its own run.
 *   3. The board is read once: the ticket's state, and the ACL-checked claim and adopt markers.
 *   4. {@link classify} seats each subject. **Nothing is removed on a `Hold`**, and a read that
 *      failed refuses on `11` rather than resolve to either verdict.
 *   5. Each released tree is **salvaged then removed**, in ADR 0321's order and under its ban on
 *      `--force`: uncommitted work goes onto the tree's own branch first, so ignoring dirtiness
 *      costs nobody their only copy, and a removal that still refuses is reported for a human.
 *   6. Every removal is read back off a second `worktree list` — a removal this verb reports is one
 *      it proved, never one `git` exited 0 on.
 *
 * It removes the tree and leaves the branch: the repair lane the pin refused needs exactly that ref.
 *
 * **A worktree-isolated caller may run this**, which is what moved ADR 0321's obligation off the
 * primary-checkout driver: the harness rule that refused a cross-worktree `git` reads the typed
 * command, so it binds a shell and not a verb's own child process (measured on #6610).
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {getIssue} from "../io/issues.ts";
import {getPullRequest} from "../io/pulls.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {readClaimants} from "./claim.ts";
import {
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WORKTREE_HELD,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {
	pruneWorktrees,
	removeWorktree,
	salvageWorktree,
	worktreeCheckouts,
	worktreeDirtyPaths,
} from "./git.ts";
import {type BoardState, classify, type Subject, sessionsByNonce, subjectsFor} from "./retire.ts";
import {badNumber, resolveTargetRepo, scannedLine} from "./target.ts";
import {readTree} from "./tree.ts";

const VERB = "fabrika build retire";

export interface RetireOptions {
	/** The number whose lane branches are held — the child issue, or the PR a repair lane resumed. */
	readonly number: number;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

type Deps = ChildProcessSpawner.ChildProcessSpawner;

type Board =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Board"; readonly board: BoardState};

export const runRetire = (options: RetireOptions): Effect.Effect<VerbOutcome, never, Deps> =>
	Effect.gen(function* () {
		const {number} = options;
		const bad = badNumber(VERB, "an issue or pull request number", number);
		if (bad !== null) return bad;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const {repo} = resolved;

		const pruned = yield* pruneWorktrees;
		if (pruned._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot prune this clone's worktree registrations: ${pruned.reason} — which trees hold #${number}'s lane branch is UNKNOWN.`,
			);
		}

		const held = yield* subjects(number);
		if (held._tag === "Refused") return held.outcome;
		const scope = scannedLine(VERB, held.scanned, "working tree", `#${number}`);
		if (held.subjects.length === 0) {
			return answer(JSON.stringify({answer: "none", number, retired: [], held: []}), [
				scope,
				`${VERB}: no working tree of this clone holds a lane branch for #${number}.`,
			]);
		}

		const read = yield* board(repo, number);
		if (read._tag === "Refused") return read.outcome;

		const self = yield* readTree;
		if (self._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read this run's own tree root: ${self.reason} — which tree is this one is UNKNOWN, and a run that cannot recognise itself must remove nothing.`,
				[scope],
			);
		}
		const selfPaths = new Set([self.value.root]);
		const verdicts = held.subjects.map((subject) => ({
			subject,
			verdict: classify(subject, read.board, selfPaths),
		}));

		const retired: Array<{
			path: string;
			branch: string;
			license: string;
			salvaged: boolean;
		}> = [];
		for (const {subject, verdict} of verdicts) {
			if (verdict._tag !== "Release") continue;
			const salvaged = yield* salvage(subject);
			if (salvaged._tag === "Refused") return salvaged.outcome;
			const removed = yield* removeWorktree(subject.path);
			if (removed._tag === "Failure") {
				return refuse(
					WRITE_UNKNOWN,
					`${VERB}: git refused to remove ${subject.path}: ${removed.reason} — ADR 0321 bans --force on every path, so this is an incident to file (/report), not an override. ${retired.length} tree(s) were retired before it.`,
					[scope],
				);
			}
			retired.push({
				path: subject.path,
				branch: subject.branch,
				license: verdict.license,
				salvaged: salvaged.salvaged,
			});
		}

		if (retired.length > 0) {
			const after = yield* worktreeCheckouts;
			if (after._tag === "Failure") {
				return refuse(
					READBACK_MISMATCH,
					`${VERB}: ${retired.length} tree(s) were removed and the registrations could not be read back: ${after.reason} — the retirement is NOT proven.`,
					[scope],
				);
			}
			const survivor = retired.find((row) =>
				after.value.some((checkout) => checkout.path === row.path),
			);
			if (survivor !== undefined) {
				return refuse(
					READBACK_MISMATCH,
					`${VERB}: git reported ${survivor.path} removed and it is still registered — the retirement is NOT proven, and this clone needs a human.`,
					[scope],
				);
			}
		}

		const holding = verdicts.flatMap(({subject, verdict}) =>
			verdict._tag === "Release" ? [] : [{subject, verdict}],
		);
		const notes = [
			scope,
			...retired.map(
				(row) =>
					`${VERB}: retired ${row.path} — it held ${row.branch} (${row.license})${row.salvaged ? `; its uncommitted work was salvaged onto ${row.branch} first` : ""}.`,
			),
			...holding.map(
				({subject, verdict}) =>
					`${VERB}: ${subject.path} still holds ${subject.branch} — ${verdict._tag === "Self" ? "it is the tree this run is standing in, which no run may remove from inside" : verdict.because}.`,
			),
		];
		const payload = {
			answer: retired.length > 0 ? "retired" : "held",
			number,
			retired,
			held: holding.map(({subject, verdict}) => ({
				path: subject.path,
				branch: subject.branch,
				reason: verdict._tag === "Self" ? "self" : verdict.because,
			})),
		};
		return holding.length > 0 && retired.length === 0
			? refuse(
					WORKTREE_HELD,
					`${VERB}: the board licenses no release of #${number}'s lane branch — nothing was removed.`,
					notes,
				)
			: answer(JSON.stringify(payload), notes);
	});

type Salvaged =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Salvaged"; readonly salvaged: boolean};

/**
 * ADR 0321's first step: whatever the tree holds uncommitted goes onto its own branch before the
 * tree goes.
 *
 * This is what makes dirtiness a non-question rather than a tolerated risk (ADR 0323): the ruling
 * that a dirty tree is still retired and the rule that a removal must not destroy a dying spawn's
 * only copy are the same act, in this order. A read that fails salvages nothing and removes nothing.
 */
const salvage = (subject: Subject): Effect.Effect<Salvaged, never, Deps> =>
	Effect.gen(function* () {
		const dirty = yield* worktreeDirtyPaths(subject.path);
		if (dirty._tag === "Failure") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read whether ${subject.path} holds uncommitted work: ${dirty.reason} — nothing was salvaged and nothing was removed.`,
				),
			};
		}
		if (dirty.value === 0) return {_tag: "Salvaged" as const, salvaged: false};
		const committed = yield* salvageWorktree(
			subject.path,
			`wip: salvage ${dirty.value} uncommitted path(s) from a retired worktree (${subject.branch})\n`,
		);
		return committed._tag === "Failure"
			? {
					_tag: "Refused" as const,
					outcome: refuse(
						WRITE_UNKNOWN,
						`${VERB}: cannot salvage ${dirty.value} uncommitted path(s) in ${subject.path}: ${committed.reason} — the tree is left standing, because removing it would destroy the only copy (ADR 0321).`,
					),
				}
			: {_tag: "Salvaged" as const, salvaged: true};
	});

type Held =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {
			readonly _tag: "Held";
			readonly subjects: ReadonlyArray<Subject>;
			readonly scanned: number;
	  };

const subjects = (number: number): Effect.Effect<Held, never, Deps> =>
	Effect.gen(function* () {
		const checkouts = yield* worktreeCheckouts;
		if (checkouts._tag === "Failure") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read which working tree holds what: ${checkouts.reason} — whether one holds #${number}'s lane branch is UNKNOWN.`,
				),
			};
		}
		return {
			_tag: "Held" as const,
			subjects: subjectsFor(number, checkouts.value),
			scanned: checkouts.value.length,
		};
	});

/**
 * The board's two answers about `number`, in one read each.
 *
 * A pull request's terminal state is `merged`, never `closed`: a PR closed unmerged can be reopened
 * onto the same head, so treating it as terminal would retire a tree whose work is still live. An
 * issue's is `closed` — the state its own children's builds end in.
 */
const board = (repo: string, number: number): Effect.Effect<Board, never, Deps> =>
	Effect.gen(function* () {
		const no = (code: number, reason: string): Board => ({
			_tag: "Refused",
			outcome: refuse(code, reason),
		});

		const found = yield* getIssue(repo, number);
		if (found._tag === "Absent") {
			return no(
				ZERO_SCOPE,
				`${VERB}: #${number} is proven absent — there is no board state to license a release with.`,
			);
		}
		if (found._tag === "Unknown") {
			return no(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read #${number}: ${found.reason} — whether its ticket is terminal is UNKNOWN, never "terminal".`,
			);
		}

		let terminal = found.value.state === "closed";
		let describe = terminal ? "is closed" : "is open";
		if (found.value.isPullRequest) {
			const pull = yield* getPullRequest(repo, number);
			if (pull._tag !== "Present") {
				return no(
					PRECONDITION_UNKNOWN,
					`${VERB}: #${number} is a pull request and could not be read as one${pull._tag === "Unknown" ? `: ${pull.reason}` : ""} — whether it merged is UNKNOWN.`,
				);
			}
			terminal = pull.value.merged;
			describe = terminal
				? "is merged"
				: `is a pull request that has not merged (${pull.value.state})`;
		}

		const claimants = yield* readClaimants(repo, number);
		if (claimants._tag === "Unknown") {
			return no(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the claim markers on #${number}: ${claimants.reason} — whether a holding session was adopted is UNKNOWN, never "not adopted".`,
			);
		}

		return {
			_tag: "Board",
			board: {
				terminal,
				describe,
				adoptedSessions: claimants.adopts
					.filter((adopt) => adopt.authorized)
					.map((adopt) => adopt.adopted),
				sessionByNonce: sessionsByNonce(claimants.claimants),
			},
		};
	});
