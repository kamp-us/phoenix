/**
 * What it means for a guard to be a **local-tree guard**, and the two constructors that say so.
 *
 * A local-tree guard is argument-free, reads only the checked-out tree, and needs no pull-request
 * number, no board read and no auth. `build check` sweeps exactly that set on every surface, so a
 * guard that reds in CI reds on the builder's machine first.
 *
 * This module holds the **shape** and never the membership. Every row is declared beside its own
 * registration in `command.ts`, because a second list — here, in a config file, in a workflow, or in
 * a skill — is the drift the decision exists to prevent.
 */

import type {Effect, FileSystem, Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import type {VerbOutcome} from "../verb.ts";

/**
 * One local-tree guard's invocation, bound to the tree it judges.
 *
 * The three services are the ceiling the predicate implies: the filesystem and path for the walk,
 * the spawner for the guards that shell out to `git` against this same checkout. An `HttpClient`
 * here would mean the guard reads the board, which is what disqualifies it.
 */
export type LocalTreeRun = (options: {
	readonly root: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}) => Effect.Effect<
	VerbOutcome,
	never,
	FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
>;

/** A member of the local-tree set, as `build check` invokes and names it. */
export interface LocalTreeGuard {
	/** The guard's name, read off its own command so the two spellings cannot drift. */
	readonly name: string;
	/** The leaf that runs it — `check` for most, `validate` for `decisions-index`. */
	readonly leaf: string;
	readonly run: LocalTreeRun;
}

/**
 * A registered guard's membership answer.
 *
 * The refusing arm carries its reason as data rather than a comment: a row that cannot name the
 * clause of the predicate it fails is a row whose membership was never decided.
 */
export type Membership =
	| {readonly _tag: "LocalTree"; readonly guard: LocalTreeGuard}
	| {readonly _tag: "NotLocalTree"; readonly why: string};

/** One registry row: the registered command and its membership, side by side. */
export interface GuardRow<C extends {readonly name: string}> {
	readonly command: C;
	readonly membership: Membership;
}

/**
 * Register a guard as a member: `build check` runs `leaf` over the checked-out tree.
 *
 * The name comes off the command, so a member cannot be registered under a name the CLI does not
 * answer to.
 */
export const localTree = <C extends {readonly name: string}>(
	command: C,
	leaf: string,
	run: LocalTreeRun,
): GuardRow<C> => ({
	command,
	membership: {_tag: "LocalTree", guard: {name: command.name, leaf, run}},
});

/** Register a guard as a non-member, naming the clause of the predicate it fails. */
export const notLocalTree = <C extends {readonly name: string}>(
	command: C,
	why: string,
): GuardRow<C> => ({command, membership: {_tag: "NotLocalTree", why}});

/** The members of a registry, in registration order — the set `build check` sweeps. */
export const membersOf = (
	rows: ReadonlyArray<GuardRow<{readonly name: string}>>,
): ReadonlyArray<LocalTreeGuard> =>
	rows.flatMap((row) => (row.membership._tag === "LocalTree" ? [row.membership.guard] : []));
