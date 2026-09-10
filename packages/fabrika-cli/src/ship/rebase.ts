/**
 * The rebase `ship enqueue` takes on a definite `dirty` read, instead of routing the lane to repair.
 *
 * `mergeable_state: dirty` is a fact about the **base**, not a verdict on the head: the base moved
 * onto a path the branch also touches. Routed to repair it costs a build retry plus a full
 * re-review, and on a busy surface that window is longer than the interval at which the base moves,
 * so the next enqueue conflicts again and the loop outruns itself — measured on a live lane: two
 * consecutive rounds, retries 0 to 2 of 3, no defect in the diff either round.
 *
 * **A clean rebase owes no new review round.** A verdict binds to the head's *content*, not to its
 * SHA (`../review/head-content.ts`), so a replay that merges the base without
 * touching a hunk leaves every PASS bound and the caller re-enqueues on the verdicts already there.
 * A rebase that **conflicts** is the opposite case and is never resolved here: resolving hunks
 * changes content, which is a new head like any other, and that belongs to a repair round.
 *
 * The replay runs in a temporary detached worktree, never in the caller's checkout. `ship` is
 * invoked from whatever tree the shipper stands in, and switching that tree to publish a rebase
 * would mutate a lane this verb does not own.
 */
import {Effect} from "effect";
import {execCapture} from "../io/exec.ts";
import {
	type Attempt,
	fail,
	fetchAndResolve,
	fetchRef,
	isObjectName,
	ok,
	remoteSha,
	resolveCommit,
	type Shell,
} from "../io/git.ts";

/**
 * What the replay did, in the four outcomes that route differently.
 *
 * `Unattempted` and `Unknown` are kept apart because they say opposite things about the remote:
 * nothing was published under the first, and under the second whether the branch moved is unread.
 * Folding them would let a caller report a conflict on a branch it may have already rewritten.
 */
export type RebaseOutcome =
	| {readonly _tag: "Republished"; readonly head: string}
	| {readonly _tag: "Conflicted"; readonly reason: string}
	| {readonly _tag: "Unattempted"; readonly reason: string}
	| {readonly _tag: "Unknown"; readonly reason: string};

export interface RebaseTarget {
	readonly remote: string;
	/** The PR's head branch — what gets replayed and pushed. */
	readonly ref: string;
	/** The head the caller read, and the lease the push is taken under. */
	readonly headSha: string;
	/** The PR's own base branch, never a hardcoded trunk spelling. */
	readonly baseRef: string;
}

const conflicted = (reason: string): RebaseOutcome => ({_tag: "Conflicted", reason});
const unattempted = (reason: string): RebaseOutcome => ({_tag: "Unattempted", reason});
const unknown = (reason: string): RebaseOutcome => ({_tag: "Unknown", reason});

/**
 * Hooks off for every command here — `core.hooksPath` pointed at a path that holds none.
 *
 * The forcing constraint is the temporary worktree, and it is two hooks. `git worktree add` fires
 * `post-checkout`, whose hook wrapper has aborted a spawn outright under an agent harness's
 * stripped-PATH environment; `git push` fires `pre-push`, whose typecheck cannot run in a detached
 * tree carrying no installed dependencies. Neither is being bypassed as a gate: a repository's hooks
 * are its local *authoring* fast-fail, and this replays bytes the PR's own CI run already graded.
 */
const HOOKS_OFF = ["-c", "core.hooksPath=/dev/null"];

/** How a base reads in a diagnostic — the spelling the replay was taken against. */
export const baseLabelOf = (target: RebaseTarget): string => `${target.remote}/${target.baseRef}`;

/** The directory the scratch worktree is opened in, under the clone's own git dir. */
const scratchPath = (pr: number, headSha: string): Shell<Attempt<string>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", ["rev-parse", "--git-common-dir"]);
		const dir = r.stdout.trim();
		if (!r.ok) return fail(r.reason);
		return dir === ""
			? fail("`git rev-parse --git-common-dir` named no directory")
			: ok(`${dir}/fabrika-rebase/${pr}-${headSha.slice(0, 12)}`);
	});

/**
 * Replay the head onto the fetched base inside the scratch tree, publish it, and read the remote
 * back.
 *
 * A `rebase` that exits non-zero has left the tree mid-replay, so the abort is unconditional before
 * anything else runs — a scratch tree that outlives this call is a worktree removal that refuses.
 */
const replayAndPublish = (path: string, target: RebaseTarget, base: string): Shell<RebaseOutcome> =>
	Effect.gen(function* () {
		const replayed = yield* execCapture("git", [...HOOKS_OFF, "-C", path, "rebase", base]);
		if (!replayed.ok) {
			yield* execCapture("git", [...HOOKS_OFF, "-C", path, "rebase", "--abort"]);
			return conflicted(replayed.reason);
		}
		const tip = yield* execCapture("git", ["-C", path, "rev-parse", "HEAD"]);
		const head = tip.stdout.trim();
		if (!tip.ok || !isObjectName(head)) {
			return unattempted(
				`the replayed head could not be resolved: ${tip.ok ? `git printed "${head}"` : tip.reason}`,
			);
		}
		// A replay that moves nothing has not merged the base, so the conflict is one no rebase
		// resolves — reporting it as republished would arm a head the platform still calls dirty.
		if (head === target.headSha) {
			return unattempted(`the replay onto ${baseLabelOf(target)} left the head where it was`);
		}
		const pushed = yield* execCapture("git", [
			...HOOKS_OFF,
			"-C",
			path,
			"push",
			`--force-with-lease=${target.ref}:${target.headSha}`,
			target.remote,
			`HEAD:refs/heads/${target.ref}`,
		]);
		if (!pushed.ok) return unattempted(`the rebased head was not published: ${pushed.reason}`);
		const witness = yield* remoteSha(target.remote, target.ref);
		if (witness._tag === "Failure") {
			return unknown(`the rebased head was pushed and the remote could not be read back`);
		}
		return witness.value === head
			? {_tag: "Republished", head}
			: unknown(
					`the push reported success and ${target.remote}/${target.ref} reads ${witness.value ?? "nothing"}, not ${head}`,
				);
	});

/**
 * Rebase the PR's head branch onto its base and publish the result.
 *
 * The base is fetched before it is read: a stale `origin/<base>` would replay onto the commit this
 * clone last saw, which is the very state the `dirty` read says has moved on.
 */
export const rebaseOntoBase = (pr: number, target: RebaseTarget): Shell<RebaseOutcome> =>
	Effect.gen(function* () {
		const base = yield* fetchAndResolve(baseLabelOf(target));
		if (base._tag === "Failure") {
			return unattempted(`cannot fetch ${baseLabelOf(target)}: ${base.reason}`);
		}
		const fetched = yield* fetchRef(target.remote, target.ref);
		if (fetched._tag === "Failure") {
			return unattempted(`cannot fetch ${target.remote}/${target.ref}: ${fetched.reason}`);
		}
		const head = yield* resolveCommit(target.headSha);
		if (head._tag === "Failure") return unattempted(head.reason);

		const path = yield* scratchPath(pr, target.headSha);
		if (path._tag === "Failure") {
			return unattempted(`cannot site a scratch worktree: ${path.reason}`);
		}
		const added = yield* execCapture("git", [
			...HOOKS_OFF,
			"worktree",
			"add",
			"--detach",
			path.value,
			target.headSha,
		]);
		if (!added.ok) return unattempted(`cannot open a scratch worktree: ${added.reason}`);

		const outcome = yield* replayAndPublish(path.value, target, base.value);
		// Never `--force`: the ban holds for every tree. A scratch tree this verb opened detached and
		// left with a clean status has nothing for the plain removal to refuse over.
		yield* execCapture("git", ["worktree", "remove", path.value]);
		return outcome;
	});
