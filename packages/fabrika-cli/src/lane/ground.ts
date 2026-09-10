/**
 * Whether a lanes root stands where its ledger really lives — the two facts that can be wrong, their
 * refusals, and the guard every rooted `lane` verb runs through.
 *
 * A lanes root is a path (`.fabrika/lanes`, `.fabrika/chores`), so a relative one is joined onto
 * whatever cwd the process happens to hold. When that cwd drifts off the repo — a session scratchpad,
 * a subdirectory — the root resolves somewhere nobody meant, and the load path proves the lane
 * *absent*: the same `7` a repo with no such lane answers, which `operate` reads as "boot a fresh
 * ledger". A drifted-cwd boot then writes a second ledger over a live lane. "Not a repo" is a
 * different fact from "no lane here", and only the second may mean boot.
 *
 * An **absolute** root expresses no cwd drift, but it owes a probe of its own: it can still point at
 * a *linked worktree's* copy of a lanes root. `.fabrika` is gitignored, so no worktree inherits one
 * from its branch — but anything that writes a lanes root under a worktree makes a second ledger for
 * the same lane, and folding it answers from a frozen moment instead of failing. That is what lane
 * 8810 did: a shell folded a worktree copy, read a `tripped` lane whose task was `frozen`, and
 * refused a terminal the live ledger would have taken. So every root, absolute or relative, is
 * proven to sit in the working tree that OWNS it, and one inside a linked worktree is refused on
 * {@link ROOT_NOT_OWNED} rather than read.
 */
import {Effect, type FileSystem, Option, Path, Result} from "effect";
import {repositoryOf} from "../delegate/repository.ts";
import {exists, realPath} from "../io/fs.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {LANE_UNREADABLE, NOT_A_REPO, ROOT_NOT_OWNED} from "./codes.ts";

/** What marks a directory as a repo checkout: fabrika's own state, or git's (a file in a worktree). */
export const REPO_MARKERS = [".fabrika", ".git"] as const;

export type Ground =
	| {readonly _tag: "Grounded"}
	| {readonly _tag: "NotARepo"; readonly cwd: string; readonly roots: ReadonlyArray<string>}
	| {
			readonly _tag: "ForeignWorktree";
			readonly root: string;
			readonly workingTree: string;
			readonly owner: string;
	  }
	| {readonly _tag: "Unprobeable"; readonly path: string; readonly reason: string};

/** Whether the cwd a relative root would be joined onto is a repo checkout at all. */
const proveCwd = (
	relative: ReadonlyArray<string>,
	cwd: string,
): Effect.Effect<Ground, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
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
 * Whether one resolved root stands in the working tree that owns it. A root under no working tree at
 * all is grounded — a relocated lanes root belongs to nobody and duplicates nothing.
 */
const proveOwnership = (
	root: string,
	cwd: string,
): Effect.Effect<Ground, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const at = path.resolve(cwd, root);
		const owner = yield* deriveRepoRoot(at);
		if (owner._tag === "Unestablished") {
			return {_tag: "Unprobeable", path: at, reason: owner.reason} as const;
		}
		if (owner._tag === "NotARepo") return {_tag: "Grounded"} as const;
		return owner.workingTree === owner.repoRoot
			? ({_tag: "Grounded"} as const)
			: ({
					_tag: "ForeignWorktree",
					root: at,
					workingTree: owner.workingTree,
					owner: owner.repoRoot,
				} as const);
	});

/**
 * Prove the ground under every root a verb is about to resolve — both facts, in the order whose
 * refusal is the more basic. A probe that could not be performed is UNKNOWN, never a repo: an
 * unproven ground may not license a boot any more than a drifted one.
 */
export const proveGround = (
	roots: ReadonlyArray<string>,
	cwd: string,
): Effect.Effect<Ground, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const relative = roots.filter((root) => !path.isAbsolute(root));
		if (relative.length > 0) {
			const grounded = yield* proveCwd(relative, cwd);
			if (grounded._tag !== "Grounded") return grounded;
		}
		for (const root of roots) {
			const owned = yield* proveOwnership(root, cwd);
			if (owned._tag !== "Grounded") return owned;
		}
		return {_tag: "Grounded"} as const;
	});

/**
 * Seat a ground that is not a repo, saying which fact it is: the cwd is wrong, NOT that this repo
 * holds no such lane. A caller reading `7` boots; a caller reading this one moves.
 */
export const groundRefusal = (
	verb: string,
	ground: Exclude<Ground, {_tag: "Grounded"}>,
): VerbOutcome => {
	if (ground._tag === "Unprobeable") {
		return refuse(
			LANE_UNREADABLE,
			`${verb}: cannot establish whether ${ground.path} is there: ${ground.reason} — whether this is a repo is UNKNOWN, never a lane's absence.`,
		);
	}
	if (ground._tag === "ForeignWorktree") {
		return refuse(
			ROOT_NOT_OWNED,
			`${verb}: ${ground.root} is inside the linked worktree ${ground.workingTree}, whose owning repository is ${ground.owner} — a worktree's own lanes root is a second copy of that repository's ledger, frozen at whatever moment it was written. This is NOT "no lane here" and it is not a ledger to fold: drop --root so it derives off ${ground.owner}, or pass one under ${ground.owner}.`,
		);
	}
	return refuse(
		NOT_A_REPO,
		`${verb}: ${ground.cwd} is not a repo — it holds neither ${REPO_MARKERS.join(" nor ")}, so ${ground.roots.join(", ")} resolves somewhere nobody meant. This is NOT "no lane here": run from the repo root, or pass --root as an absolute path.`,
	);
};

/**
 * The default lanes root resolved against the repository the cwd belongs to — never against the
 * cwd itself. The owning repository is the one whose common dir the cwd's nearest `.git`
 * entry answers to (`delegate/repository.ts`), so a linked worktree and the
 * primary checkout derive the SAME ledger: the worktree's `.git` file points into the primary's
 * git dir, whose `commondir` file names it back. A cwd whose repository cannot be established is
 * UNKNOWN — never a cwd-relative fallback, which would reintroduce the drift bug quietly.
 */
export type RepoGround =
	| {readonly _tag: "Derived"; readonly repoRoot: string; readonly workingTree: string}
	| {readonly _tag: "NotARepo"; readonly cwd: string}
	| {readonly _tag: "Unestablished"; readonly cwd: string; readonly reason: string};

/**
 * Walk up from the cwd to the nearest `.git` entry, then read its repository's common dir. The
 * entry's own directory rides along as `workingTree`: a linked worktree and its primary checkout
 * derive one `repoRoot`, so that pair is the only thing that can tell them apart.
 *
 * Both come back real-path resolved, because `repoRoot` is derived through `repositoryOf`'s own
 * `realPath` and a raw walked path would differ from it on any symlinked ancestor — macOS's
 * `/var` → `/private/var` alone makes every temp checkout compare unequal to itself.
 */
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
		if (common.success === undefined) {
			return {
				_tag: "Unestablished",
				cwd,
				reason: `${path.join(current, ".git")} does not name a readable repository`,
			} as const;
		}
		const tree = yield* Effect.result(realPath(current));
		return Result.isFailure(tree)
			? ({_tag: "Unestablished", cwd, reason: tree.failure.reason} as const)
			: ({
					_tag: "Derived",
					repoRoot: path.dirname(common.success),
					workingTree: tree.success,
				} as const);
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
				`${verb}: whether ${ground.cwd} belongs to a repository is UNKNOWN (${ground.reason}) — the lanes root stays unresolved rather than guessed from the cwd.`,
			);

/**
 * The lanes root one verb invocation resolves when `--root` is absent: derived off the repository
 * the cwd belongs to, with the leaf joined under its primary checkout. An explicit `--root`
 * wins over whatever would be derived.
 *
 * Shared rather than private to the `lane` adapter, because a verb in another group resolving the
 * same root its own way is how one lane key comes to name two directories: `recipe unpark` defaulted
 * to a bare cwd-relative leaf and proved every worktree-driven lane absent. The verb label
 * arrives whole, so a caller outside `lane` names itself.
 *
 * An explicit root is proven through {@link proveGround} here rather than only at {@link onGround},
 * because `recipe unpark` reaches this verb and that guard both — a root it took on trust is a root
 * nothing checked.
 */
export const resolveRootOrRefuse = (
	verb: string,
	root: Option.Option<string>,
	leaf: string,
	cwd: string,
): Effect.Effect<string | VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		if (Option.isSome(root)) {
			const ground = yield* proveGround([root.value], cwd);
			return ground._tag === "Grounded" ? root.value : groundRefusal(verb, ground);
		}
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
