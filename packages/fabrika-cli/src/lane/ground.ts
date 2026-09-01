/**
 * Whether the directory a relative lanes root resolves against is a repo at all — the fact, its
 * refusal, and the guard every rooted `lane` verb runs through.
 *
 * A lanes root is a path (`.fabrika/lanes`, `.fabrika/chores`), so a relative one is joined onto
 * whatever cwd the process happens to hold. When that cwd drifts off the repo — a session scratchpad,
 * a subdirectory — the root resolves somewhere nobody meant, and the load path proves the lane
 * *absent*: the same `7` a repo with no such lane answers, which `operate` reads as "boot a fresh
 * ledger". A drifted-cwd boot then writes a second ledger over a live lane (#6212). "Not a repo" is a
 * different fact from "no lane here", and only the second may mean boot.
 *
 * An **absolute** root resolves against nothing, so no drift is expressible and no probe is owed —
 * `lane brief` hands a shell its driver's root absolute for exactly that reason.
 */
import {Effect, type FileSystem, Option, Path, Result} from "effect";
import {repositoryOf} from "../delegate/repository.ts";
import {exists} from "../io/fs.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {LANE_UNREADABLE, NOT_A_REPO} from "./codes.ts";

/** What marks a directory as a repo checkout: fabrika's own state, or git's (a file in a worktree). */
export const REPO_MARKERS = [".fabrika", ".git"] as const;

export type Ground =
	| {readonly _tag: "Grounded"}
	| {readonly _tag: "NotARepo"; readonly cwd: string; readonly roots: ReadonlyArray<string>}
	| {readonly _tag: "Unprobeable"; readonly path: string; readonly reason: string};

/**
 * Prove the ground under every root a verb is about to resolve. A probe that could not be performed
 * is UNKNOWN, never a repo: an unproven ground may not license a boot any more than a drifted one.
 */
export const proveGround = (
	roots: ReadonlyArray<string>,
	cwd: string,
): Effect.Effect<Ground, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const relative = roots.filter((root) => !path.isAbsolute(root));
		if (relative.length === 0) return {_tag: "Grounded"} as const;

		for (const marker of REPO_MARKERS) {
			const at = path.join(cwd, marker);
			const probe = yield* Effect.result(exists(at));
			if (Result.isFailure(probe)) {
				return {_tag: "Unprobeable", path: at, reason: probe.failure.reason} as const;
			}
			if (probe.success) return {_tag: "Grounded"} as const;
		}
		return {_tag: "NotARepo", cwd, roots: relative} as const;
	});

/**
 * Seat a ground that is not a repo, saying which fact it is: the cwd is wrong, NOT that this repo
 * holds no such lane. A caller reading `7` boots; a caller reading this one moves.
 */
export const groundRefusal = (
	verb: string,
	ground: Exclude<Ground, {_tag: "Grounded"}>,
): VerbOutcome =>
	ground._tag === "Unprobeable"
		? refuse(
				LANE_UNREADABLE,
				`${verb}: cannot establish whether ${ground.path} is there: ${ground.reason} — whether this is a repo is UNKNOWN, never a lane's absence.`,
			)
		: refuse(
				NOT_A_REPO,
				`${verb}: ${ground.cwd} is not a repo — it holds neither ${REPO_MARKERS.join(" nor ")}, so ${ground.roots.join(", ")} resolves somewhere nobody meant. This is NOT "no lane here": run from the repo root, or pass --root as an absolute path.`,
			);

/**
 * The default lanes root resolved against the repository the cwd belongs to — never against the
 * cwd itself (#5815). The owning repository is the one whose common dir the cwd's nearest `.git`
 * entry answers to (`delegate/repository.ts`, ADR 0287's identity), so a linked worktree and the
 * primary checkout derive the SAME ledger: the worktree's `.git` file points into the primary's
 * git dir, whose `commondir` file names it back. A cwd whose repository cannot be established is
 * UNKNOWN — never a cwd-relative fallback, which would reintroduce the drift bug quietly.
 */
export type RepoGround =
	| {readonly _tag: "Derived"; readonly repoRoot: string}
	| {readonly _tag: "NotARepo"; readonly cwd: string}
	| {readonly _tag: "Unestablished"; readonly cwd: string; readonly reason: string};

/** Walk up from the cwd to the nearest `.git` entry, then read its repository's common dir. */
export const deriveRepoRoot = (
	cwd: string,
): Effect.Effect<RepoGround, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		let current = path.resolve(cwd);
		for (;;) {
			const probe = yield* Effect.result(exists(path.join(current, ".git")));
			if (Result.isFailure(probe)) {
				return {_tag: "Unestablished", cwd, reason: probe.failure.reason} as const;
			}
			if (probe.success) break;
			const parent = path.dirname(current);
			if (parent === current) return {_tag: "NotARepo", cwd} as const;
			current = parent;
		}
		const common = yield* Effect.result(repositoryOf(current));
		if (Result.isFailure(common)) {
			return {_tag: "Unestablished", cwd, reason: common.failure.reason} as const;
		}
		return common.success === undefined
			? ({
					_tag: "Unestablished",
					cwd,
					reason: `${path.join(current, ".git")} does not name a readable repository`,
				} as const)
			: ({_tag: "Derived", repoRoot: path.dirname(common.success)} as const);
	});

/** Seat a derivation that did not reach a repository — each fact on its own code. */
export const repoGroundRefusal = (
	verb: string,
	ground: Exclude<RepoGround, {_tag: "Derived"}>,
): VerbOutcome =>
	ground._tag === "NotARepo"
		? refuse(
				NOT_A_REPO,
				`${verb}: ${ground.cwd} is not a repo — no ancestor holds a .git entry, so the lanes root has no repository to resolve against. This is NOT "no lane here": run from the repo, or pass --root.`,
			)
		: refuse(
				LANE_UNREADABLE,
				`${verb}: whether ${ground.cwd} belongs to a repository is UNKNOWN (${ground.reason}) — the lanes root stays unresolved rather than guessed from the cwd (#5815).`,
			);

/**
 * The lanes root one verb invocation resolves when `--root` is absent: derived off the repository
 * the cwd belongs to (#5815), with the leaf joined under its primary checkout. An explicit `--root`
 * wins over whatever would be derived.
 *
 * Shared rather than private to the `lane` adapter, because a verb in another group resolving the
 * same root its own way is how one lane key comes to name two directories: `recipe unpark` defaulted
 * to a bare cwd-relative leaf and proved every worktree-driven lane absent (#7380). The verb label
 * arrives whole, so a caller outside `lane` names itself.
 */
export const resolveRootOrRefuse = (
	verb: string,
	root: Option.Option<string>,
	leaf: string,
	cwd: string,
): Effect.Effect<string | VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Option.isSome(root)
		? Effect.succeed(root.value)
		: Effect.gen(function* () {
				const path = yield* Path.Path;
				const ground = yield* deriveRepoRoot(cwd);
				return ground._tag === "Derived"
					? path.join(ground.repoRoot, leaf)
					: repoGroundRefusal(verb, ground);
			});

/**
 * Run a rooted verb on ground it proved. The group-level guard ahead of every read and every boot,
 * so no verb re-checks and none can forget: a root reaches a verb only through here.
 */
export const onGround = <R>(
	verb: string,
	roots: ReadonlyArray<string>,
	cwd: string,
	run: () => Effect.Effect<VerbOutcome, never, R>,
): Effect.Effect<VerbOutcome, never, R | FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const ground = yield* proveGround(roots, cwd);
		return ground._tag === "Grounded"
			? yield* run()
			: groundRefusal(`fabrika lane ${verb}`, ground);
	});
