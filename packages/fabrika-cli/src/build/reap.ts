/**
 * The reclamation predicate `build reap` turns on: is this finished agent worktree provably safe to
 * remove?
 *
 * Pure, and separated from the verb because the whole fail-safe rule lives here — **anything short
 * of a positive proof is KEEP.** Dirty, locked, detached-and-unlanded, still in use, or any read
 * that failed all answer KEEP, so a tree is removed only when four positive facts hold together:
 * nothing uncommitted in it, no lock on it, its HEAD already carried by the trunk, and no liveness
 * signal on the tree itself.
 *
 * That fourth fact is not a git fact, and it is here because the three git ones are blind to a whole
 * class of tree. An operator or reviewer seat drives its lane without ever committing and usually
 * without editing a file, so its HEAD sits on the trunk and its status is clean for its entire life
 * — the exact shape the git facts read as "carries nothing". One such seat was removed mid-drive, so
 * {@link Liveness} carries whatever the sweep could observe about the tree still being in use, and
 * any live **or unreadable** signal is a KEEP.
 *
 * That is the opposite polarity from `./retire.ts`, and deliberately: a retirement is a *targeted*
 * act against one number the board has spoken about, so dirtiness is ruled out of it. A reap
 * is a *bulk* act over trees nobody named, so it has no board statement to lean on and has to read
 * the tree itself for every scrap of evidence that somebody is still using it.
 *
 * The trunk's answer about a tree's HEAD is `../io/containment.ts`'s {@link Containment}, shared
 * with `lane assembly`'s resume guard. The subject there is the **commit**, not a branch name,
 * because most of the leaked population holds no branch at all: the harness detaches the trees it
 * registers, so a rule keyed on a branch would classify 52 of this clone's 74 agent trees as
 * unjudgeable and reclaim none of them.
 */
import type {Containment} from "../io/containment.ts";

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

/** What one tree's own directory answered about uncommitted work. */
export type Uncommitted =
	| {readonly _tag: "Read"; readonly paths: number}
	| {readonly _tag: "Unknown"; readonly reason: string};

/**
 * How long a tree's own directory has to have gone unchanged before its quiet counts as evidence
 * nobody holds it.
 *
 * Read what the signal is before tuning this. A directory's mtime tracks its **entry list** — POSIX
 * marks `st_mtime` for update on the calls that add, remove or rename an entry in it, and on nothing
 * else ([POSIX.1-2024, `<sys/stat.h>`](https://pubs.opengroup.org/onlinepubs/9799919799/basedefs/sys_stat.h.html);
 * verified on darwin/APFS: appending to a nested file moved neither its own directory's mtime nor
 * the root's, and only a create directly at the root moved the root's). Writing a file that already
 * exists moves nothing. For the seat class this arm exists to protect — an operator or reviewer that
 * drives its lane without editing — nothing ever touches the worktree root's entry list, so the
 * root's mtime stays its **provisioning time** for the seat's whole life, and the reading is "was
 * this tree provisioned inside the window", not "has anybody been active in it".
 *
 * So the window has to cover a seat's whole plausible life, not its idle gap: the harness watchdog's
 * 600s bounds inactivity rather than total life and cannot carry this number. A day is well past any
 * seat's observed life and still reclaims the bulk of a population measured in weeks. The residual
 * gap is real and bounded — a seat driving one lane past a day reads Quiet and is removable again —
 * and it closes with the signals {@link LiveSignal} names as still unlanded, not by stretching this.
 */
export const QUIET_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * One observation that a tree is still in use.
 *
 * A union rather than a boolean because the sweep names *which* signal held in its report, and
 * because the set is meant to grow: a claim marker on the board naming the tree's lane, and a
 * running process whose cwd is inside it, are both signals this arm should eventually carry.
 */
export type LiveSignal = {
	readonly _tag: "RecentActivity";
	readonly ageSeconds: number;
	readonly windowSeconds: number;
};

/**
 * What the sweep observed about one tree still being in use.
 *
 * `Live` carries a non-empty list because the arm is a **disjunction** — any one signal is enough,
 * and a `Live` with nothing in it would be a verdict with no reason to print.
 */
export type Liveness =
	| {readonly _tag: "Live"; readonly signals: readonly [LiveSignal, ...ReadonlyArray<LiveSignal>]}
	| {readonly _tag: "Quiet"}
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
	readonly landing: Containment;
	readonly liveness: Liveness;
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
	if (facts.liveness._tag === "Live") {
		return {
			_tag: "Keep",
			because: `it reads live — ${facts.liveness.signals.map(describeSignal).join("; ")} — and a seat drives its lane without ever committing, so no git fact would show it is in use`,
		};
	}
	if (facts.liveness._tag === "Unknown") {
		return {
			_tag: "Keep",
			because: `whether it is still in use is UNKNOWN: ${facts.liveness.reason}`,
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
			because: `it holds ${facts.uncommitted.paths} uncommitted path(s), which is a bulk sweep's strongest git-level evidence that somebody is still using it`,
		};
	}
	return {
		_tag: "Remove",
		license: licenseOf(facts.landing),
		because: whyLanded(facts.landing, trunk),
	};
};

/** How long ago, in the coarsest unit that still reads as a duration to a human. */
const humanAge = (seconds: number): string => {
	const s = Math.max(0, Math.round(seconds));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.round(s / 60)}m`;
	if (s < 86_400) return `${Math.round(s / 3600)}h`;
	return `${Math.round(s / 86_400)}d`;
};

const describeSignal = (signal: LiveSignal): string => {
	switch (signal._tag) {
		case "RecentActivity":
			return `its directory was last written ${humanAge(signal.ageSeconds)} ago, inside the ${humanAge(signal.windowSeconds)} quiet window`;
	}
};

const licenseOf = (landing: Containment): License => {
	switch (landing._tag) {
		case "Ancestor":
			return "ancestor";
		case "Squashed":
			return "squashed";
		default:
			return "no-change";
	}
};

const whyLanded = (landing: Containment, trunk: string): string => {
	switch (landing._tag) {
		case "Ancestor":
			return `it is clean, unlocked, quiet, and its HEAD is reachable from ${trunk}`;
		case "Squashed":
			return `it is clean, unlocked, quiet, and what its HEAD adds landed on ${trunk} as ${landing.commit}`;
		default:
			return `it is clean, unlocked, quiet, and its HEAD adds nothing ${trunk} does not already carry`;
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
