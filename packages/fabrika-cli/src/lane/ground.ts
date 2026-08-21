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
import {Effect, type FileSystem, Path, Result} from "effect";
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
