/**
 * The reclamation predicate `build reap` turns on: is this finished agent worktree provably safe to
 * remove?
 *
 * Pure, and separated from the verb because the whole fail-safe rule lives here — **anything short
 * of a positive proof is KEEP.** Dirty, locked, detached-and-unlanded, or any read that failed all
 * answer KEEP, so a tree is removed only when three positive facts hold together: nothing
 * uncommitted in it, no lock on it, and its HEAD already carried by the trunk.
 *
 * That is the opposite polarity from `./retire.ts`, and deliberately: a retirement is a *targeted*
 * act against one number the board has spoken about, so ADR 0323 rules dirtiness out of it. A reap
 * is a *bulk* act over trees nobody named, so it has no board statement to lean on and reads
 * dirtiness as the strongest evidence it has that somebody is still using the tree.
 */

/** Where the harness registers a spawned agent's worktree. The one population this verb sweeps. */
const AGENT_DIR = "/.claude/worktrees/";
const AGENT_PREFIX = "agent-";

/** Whether a registration's path is a harness-provisioned agent worktree. */
export const isAgentWorktree = (path: string): boolean => {
	const at = path.lastIndexOf(AGENT_DIR);
	if (at < 0) return false;
	const name = path.slice(at + AGENT_DIR.length).split("/")[0] ?? "";
	return name.startsWith(AGENT_PREFIX) && name.length > AGENT_PREFIX.length;
};

/**
 * What the trunk says about a tree's HEAD commit.
 *
 * The subject is the **commit**, not the branch name, because most of the leaked population holds no
 * branch at all: the harness detaches the trees it registers, so a rule keyed on a branch would
 * classify 52 of this clone's 74 agent trees as unjudgeable and reclaim none of them. A tree that
 * does hold a branch has that branch's tip as its HEAD, so the branch case is the same read.
 *
 * `Squashed` is the case that matters: a lane branch lands as one squash commit (ADR 0048), so its
 * own commits are never ancestors of the trunk however completely their content merged.
 */
export type Landing =
	| {readonly _tag: "Ancestor"}
	| {readonly _tag: "Squashed"; readonly commit: string}
	/** The HEAD diverges from the trunk and adds no content to it — nothing here is only here. */
	| {readonly _tag: "NoChange"}
	| {readonly _tag: "Unlanded"}
	| {readonly _tag: "Unknown"; readonly reason: string};

/** What one tree's own directory answered about uncommitted work. */
export type Uncommitted =
	| {readonly _tag: "Read"; readonly paths: number}
	| {readonly _tag: "Unknown"; readonly reason: string};

/** Everything the sweep read about one registered agent worktree. */
export interface TreeFacts {
	readonly path: string;
	/** The branch it holds, or `null` when its HEAD is detached. Reported, never judged. */
	readonly branch: string | null;
	/** git's own lock reason, `""` when locked without one, `null` when unlocked. */
	readonly locked: string | null;
	/** Set when git already considers the registration stale — its directory is gone. */
	readonly prunable: boolean;
	readonly uncommitted: Uncommitted;
	readonly landing: Landing;
}

/** Why a tree may be reaped. One constructor per positive proof the trunk can give. */
export type License = "ancestor" | "squashed" | "no-change";

export type Verdict =
	| {readonly _tag: "Remove"; readonly license: License; readonly because: string}
	| {readonly _tag: "Keep"; readonly because: string};

/**
 * Seat one tree against the trunk.
 *
 * The self arm comes first for `./retire.ts`'s reason: a process cannot pull the checkout out from
 * under itself, and git would refuse one step later with a worse message. The rest is a conjunction
 * written as a chain of refusals, so the report names the *first* reason a tree survived rather than
 * a list a reader has to weigh.
 */
export const classify = (
	facts: TreeFacts,
	trunk: string,
	selfPaths: ReadonlySet<string>,
): Verdict => {
	if (selfPaths.has(facts.path)) {
		return {_tag: "Keep", because: "it is the tree this run is standing in"};
	}
	if (facts.prunable) {
		return {
			_tag: "Keep",
			because:
				"its directory is already gone, so there is no tree to remove — `git worktree prune` clears the registration",
		};
	}
	if (facts.locked !== null) {
		return {
			_tag: "Keep",
			because: `it is locked${facts.locked === "" ? "" : ` (${facts.locked})`}, and git refuses to remove a locked tree without --force`,
		};
	}
	if (facts.landing._tag === "Unknown") {
		return {_tag: "Keep", because: `whether its work landed is UNKNOWN: ${facts.landing.reason}`};
	}
	if (facts.landing._tag === "Unlanded") {
		return {
			_tag: "Keep",
			because: `it carries work ${trunk} does not — no commit there matches what its HEAD adds`,
		};
	}
	if (facts.uncommitted._tag === "Unknown") {
		return {
			_tag: "Keep",
			because: `whether it holds uncommitted work is UNKNOWN: ${facts.uncommitted.reason}`,
		};
	}
	if (facts.uncommitted.paths > 0) {
		return {
			_tag: "Keep",
			because: `it holds ${facts.uncommitted.paths} uncommitted path(s), which is the only signal a bulk sweep has that somebody is still using it`,
		};
	}
	return {
		_tag: "Remove",
		license: licenseOf(facts.landing),
		because: whyLanded(facts.landing, trunk),
	};
};

const licenseOf = (landing: Landing): License => {
	switch (landing._tag) {
		case "Ancestor":
			return "ancestor";
		case "Squashed":
			return "squashed";
		default:
			return "no-change";
	}
};

const whyLanded = (landing: Landing, trunk: string): string => {
	switch (landing._tag) {
		case "Ancestor":
			return `it is clean, unlocked, and its HEAD is reachable from ${trunk}`;
		case "Squashed":
			return `it is clean, unlocked, and what its HEAD adds landed on ${trunk} as ${landing.commit}`;
		default:
			return `it is clean, unlocked, and its HEAD adds nothing ${trunk} does not already carry`;
	}
};

/**
 * The removals whose registration survived the read-back.
 *
 * They are reported as failures, never successes, and never folded in with the removals git itself
 * refused: those two have different remedies, and a run that folded them would lose the one case
 * where this clone needs a human.
 */
export const unprovenAmong = (
	attempted: ReadonlyArray<string>,
	stillRegistered: ReadonlyArray<string>,
): ReadonlyArray<string> => {
	const survivors = new Set(stillRegistered);
	return attempted.filter((path) => survivors.has(path));
};
