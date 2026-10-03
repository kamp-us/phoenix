/**
 * The reclamation predicate `build reap` turns on: may this finished agent worktree be removed?
 *
 * Pure, and separated from the verb because the whole rule lives here. A removal takes the checkout
 * and leaves every ref, so what it can lose is exactly two things: a path nobody committed, and a
 * commit no branch, remote-tracking ref or tag reaches. The arms run in one order, and the first
 * that answers seats the tree:
 *
 *   1. {@link classifyCheap} — the run's own tree, a tree that reads live, a locked one, and one
 *      whose directory or liveness could not be read are KEEP. A registration whose directory is
 *      gone is `Prune`: there is no checkout to be unsafe about, so the sweep clears the record.
 *   2. A clean tree the trunk already carries is `Remove`, on `../io/containment.ts`'s answer.
 *   3. A clean tree whose every commit a ref reaches is `Remove`: nothing in it dies with the
 *      checkout, whether or not the trunk carries it.
 *   4. What is left holds something a removal would lose, and only the board can release it: a tree
 *      whose branch or pull request is **proven** merged or closed is `Remove`, whatever it holds.
 *   5. Everything else is KEEP, and the reason names what it holds and what could not be proven.
 *
 * **A read that failed proves nothing.** An unreadable status, an unreadable ref count, a board that
 * did not answer, and a tree holding no branch to ask the board about are all KEEP. Arm 4 is the
 * only arm that overrides what a tree holds, and it never reaches a tree arm 1 kept.
 *
 * The liveness arm is not a git fact, and it is here because the git facts are blind to a whole
 * class of tree. An operator or reviewer seat drives its lane without ever committing and usually
 * without editing a file, so its HEAD sits on the trunk and its status is clean for its entire life
 * — the exact shape the git facts read as "carries nothing". One such seat was removed mid-drive, so
 * {@link Liveness} carries whatever the sweep could observe about the tree still being in use, and
 * any live **or unreadable** signal is a KEEP.
 *
 * The trunk's answer about a tree's HEAD is `../io/containment.ts`'s {@link Containment}, shared
 * with `lane assembly`'s resume guard. The subject there is the **commit**, not a branch name,
 * because most of the leaked population holds no branch at all: the harness detaches the trees it
 * registers, so a rule keyed on a branch would classify 52 of this clone's 74 agent trees as
 * unjudgeable and reclaim none of them.
 *
 * `./retire.ts` asks the board about one number an operator named. This module asks about a branch
 * nobody named, and it reads a pull request closed unmerged as finished, where `./retire.ts` does
 * not.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10342#issuecomment-5973709319
 * @ruling https://github.com/kamp-us/phoenix/issues/10342#issuecomment-5973715141
 */
import type {Containment} from "../io/containment.ts";
import {laneNumber, parseLaneBranch} from "./lane.ts";

/**
 * The two namings a harness-provisioned agent worktree arrives under.
 *
 * `<repo>/.claude/worktrees/agent-<id>` is `hook worktree-create`'s own layout. The second is the
 * harness's, and it does not sit under the repository at all: of the operator clone's 352
 * harness-provisioned registrations measured on 2026-09-10, 243 carried the first naming and 109 the
 * second — the same snapshot the governing decision record's table reports — and the second's paths
 * split between
 * `/private/tmp/worktrees/<slug>/pi-worktree-<uuid>-s0-0` and
 * `<some-checkout>/worktrees/pi-worktree-<uuid>-s0-0`. So the second is matched on the leaf's own
 * name and nothing about where it sits: keying it to a temp root would narrow out the copies that do
 * not live there. Each tree carries its own installed dependencies rather than sharing them, so a
 * naming the sweep cannot see is gigabytes it can never reclaim.
 *
 * Widening the *population* moves no polarity: {@link classify} still needs the same proofs before a
 * tree of either naming may go.
 */
const AGENT_DIR = "/.claude/worktrees/";
const AGENT_PREFIX = "agent-";
const HARNESS_PREFIX = "pi-worktree-";

const named = (segment: string, prefix: string): boolean =>
	segment.startsWith(prefix) && segment.length > prefix.length;

/** Whether a registration's path is a harness-provisioned agent worktree, under either naming. */
export const isAgentWorktree = (path: string): boolean => {
	if (named(path.split("/").at(-1) ?? "", HARNESS_PREFIX)) return true;
	const at = path.lastIndexOf(AGENT_DIR);
	if (at < 0) return false;
	return named(path.slice(at + AGENT_DIR.length).split("/")[0] ?? "", AGENT_PREFIX);
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

/**
 * Whether the registered directory is still on disk.
 *
 * `Gone` is the one fact that licenses clearing a registration rather than removing a tree, and it
 * is the strongest proof this whole module deals in: there is no checkout, so there is nothing to
 * salvage and no session whose fate anybody has to attest to. It has exactly one source — a stat
 * that came back not-found. git's own `prunable` flag is a hint about the worktree's `.git` file
 * and not about its directory, so it never seats this; `./reap-verb.ts`'s `observe` carries the
 * measurement. The stat is the wider reading anyway: fourteen of this clone's registrations were
 * locked by a harness process dead since August with their directories long gone, and
 * `git worktree prune` skips a locked entry, so git alone never called those prunable and they
 * survived every sweep.
 *
 * `Unknown` is a stat that failed for any *other* reason — a permission, an unmounted volume — and
 * it keeps the tree. Only a not-found is proof of absence.
 */
export type Presence =
	| {readonly _tag: "Present"}
	| {readonly _tag: "Gone"; readonly because: string}
	| {readonly _tag: "Unknown"; readonly reason: string};

/**
 * The facts a sweep has in hand before it runs a single git read on the tree — the registration's
 * own fields, plus one stat.
 *
 * They are separated from the rest because {@link classifyCheap} settles most of a population on
 * them alone, and paying for the dear facts anyway is what made a sweep of this clone cost 42.8s:
 * 230 of its 243 trees were seated by a cheap arm, and every one of them had a `git status` and a
 * containment scan read for it whose answer no arm ever consulted.
 */
export interface CheapFacts {
	readonly path: string;
	/** The branch it holds, or `null` when its HEAD is detached. Reported, never judged. */
	readonly branch: string | null;
	/** git's own lock reason, `""` when locked without one, `null` when unlocked. */
	readonly locked: string | null;
	readonly presence: Presence;
	readonly liveness: Liveness;
}

/**
 * How many commits a tree's HEAD reaches that no branch, remote-tracking ref or tag reaches.
 *
 * Those are the commits a removal loses: the checkout's own HEAD is their only handle. A tree
 * standing on a branch always reads `0`, because that branch reaches its own tip.
 */
export type Stranded =
	| {readonly _tag: "Read"; readonly commits: number}
	| {readonly _tag: "Unknown"; readonly reason: string};

/** Everything git says about one registered agent worktree. */
export interface TreeFacts extends CheapFacts {
	readonly uncommitted: Uncommitted;
	readonly landing: Containment;
	readonly stranded: Stranded;
}

/**
 * What the board proved about the branch a tree holds.
 *
 * `Unproven` is every case with no answer: a detached tree has no branch to ask about, a branch may
 * name no issue or pull request, and a read may fail. It keeps the tree exactly as `Live` does, and
 * is its own arm so the report says which of the two an operator is looking at.
 */
export type BranchFate =
	/** `branch` is the one the board was asked about, which is where a salvage lands. */
	| {readonly _tag: "Ended"; readonly branch: string; readonly because: string}
	| {readonly _tag: "Live"; readonly because: string}
	| {readonly _tag: "Unproven"; readonly reason: string};

/** {@link TreeFacts} plus the board's answer, read only for a tree the git arms left open. */
export interface BoardFacts extends TreeFacts {
	readonly fate: BranchFate;
}

/**
 * Why a tree may be reaped. The first three are the trunk's proofs; `ref-reached` is a clean tree
 * whose commits all outlive it; `branch-ended` is the board's.
 */
export type License = "ancestor" | "squashed" | "no-change" | "ref-reached" | "branch-ended";

/**
 * The uncommitted paths a removal first commits onto the tree's own branch.
 *
 * `git worktree remove` refuses a tree holding any, and `--force` is banned on every path, so this
 * is the only route a dirty tree leaves by. It names the branch because a commit made on a detached
 * HEAD would go with the checkout.
 */
export interface Salvage {
	readonly paths: number;
	readonly onto: string;
}

export type Verdict =
	| {
			readonly _tag: "Remove";
			readonly license: License;
			readonly because: string;
			/** `null` under every license but `branch-ended`, the only one a dirty tree can hold. */
			readonly salvage: Salvage | null;
	  }
	/** No tree to remove — only the registration, which `git worktree prune` clears. */
	| {readonly _tag: "Prune"; readonly because: string}
	| {readonly _tag: "Keep"; readonly because: string};

/**
 * The arms answerable off {@link CheapFacts} alone, or `null` when the git reads are owed.
 *
 * Exported so the sweep can gate on it *before* paying for them, and used by {@link classify} so
 * there is one chain rather than two orderings that can drift apart.
 *
 * The self arm comes first for `./retire.ts`'s reason: a process cannot pull the checkout out from
 * under itself, and git would refuse one step later with a worse message. Absence comes next,
 * ahead of the lock: a lock protects a checkout, and there is no checkout — the fourteen
 * locked-and-gone registrations above are exactly the entries that ordering reaches.
 */
export const classifyCheap = (
	facts: CheapFacts,
	selfPaths: ReadonlySet<string>,
): Verdict | null => {
	if (selfPaths.has(facts.path)) {
		return {_tag: "Keep", because: "it is the tree this run is standing in"};
	}
	if (facts.presence._tag === "Gone") {
		return {_tag: "Prune", because: facts.presence.because};
	}
	if (facts.presence._tag === "Unknown") {
		return {
			_tag: "Keep",
			because: `whether its directory is still there is UNKNOWN: ${facts.presence.reason}`,
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
	return null;
};

/**
 * The arms git alone answers, or `null` when the tree holds something only the board can release.
 *
 * Exported so the sweep asks the board about a tree only after this returns `null`: a clean tree a
 * ref reaches is settled here and costs no request.
 *
 * An unreadable status or ref count is a KEEP here and never reaches the board. The board arm would
 * remove the tree whatever those reads said, and a tree git cannot read is not removed on a label.
 */
export const classifyGit = (
	facts: TreeFacts,
	trunk: string,
	selfPaths: ReadonlySet<string>,
): Verdict | null => {
	const cheap = classifyCheap(facts, selfPaths);
	if (cheap !== null) return cheap;
	if (facts.uncommitted._tag === "Unknown") {
		return {
			_tag: "Keep",
			because: `whether it holds uncommitted work is UNKNOWN: ${facts.uncommitted.reason}`,
		};
	}
	const clean = facts.uncommitted.paths === 0;
	const license = trunkLicense(facts.landing);
	if (clean && license !== null) {
		return {_tag: "Remove", license, because: whyLanded(facts.landing, trunk), salvage: null};
	}
	if (facts.stranded._tag === "Unknown") {
		return {
			_tag: "Keep",
			because: `whether a ref reaches every commit it holds is UNKNOWN: ${facts.stranded.reason}`,
		};
	}
	if (clean && facts.stranded.commits === 0) {
		return {
			_tag: "Remove",
			license: "ref-reached",
			because:
				"it is clean, unlocked, quiet, and a branch, remote-tracking ref or tag reaches every commit it holds, so removing the checkout loses nothing",
			salvage: null,
		};
	}
	return null;
};

/**
 * Seat one tree: the git arms first, then the board's answer about what they left open.
 *
 * Written as a chain so the report names the *first* reason a tree went or stayed.
 */
export const classify = (
	facts: BoardFacts,
	trunk: string,
	selfPaths: ReadonlySet<string>,
): Verdict => {
	const settled = classifyGit(facts, trunk, selfPaths);
	if (settled !== null) return settled;
	const paths = facts.uncommitted._tag === "Read" ? facts.uncommitted.paths : 0;
	const commits = facts.stranded._tag === "Read" ? facts.stranded.commits : 0;
	const held = [
		...(paths > 0 ? [`${paths} uncommitted path(s)`] : []),
		...(commits > 0
			? [
					`${commits} commit(s) no branch, remote-tracking ref or tag reaches${notOnTrunk(facts.landing, trunk)}`,
				]
			: []),
	].join(" and ");
	switch (facts.fate._tag) {
		case "Ended":
			return {
				_tag: "Remove",
				license: "branch-ended",
				because: `${facts.fate.because}, so what it still holds does not keep it: ${held}`,
				salvage: paths > 0 ? {paths, onto: facts.fate.branch} : null,
			};
		case "Live":
			return {
				_tag: "Keep",
				because: `it holds ${held}, and its branch is live: ${facts.fate.because}`,
			};
		case "Unproven":
			return {
				_tag: "Keep",
				because: `it holds ${held}, and whether its branch is merged or closed is not proven: ${facts.fate.reason}`,
			};
	}
};

/** Why the trunk arm did not release a tree's unreached commits. */
const notOnTrunk = (landing: Containment, trunk: string): string => {
	switch (landing._tag) {
		case "Unlanded":
			return `, which ${trunk} does not carry`;
		case "Unknown":
			return ` (whether its work landed is UNKNOWN: ${landing.reason})`;
		default:
			return "";
	}
};

/** One pull request whose head is the branch being asked about. */
export interface HeadPull {
	readonly number: number;
	readonly state: string;
	readonly merged: boolean;
}

/**
 * What the pull requests on a branch prove, or `null` when it has none.
 *
 * One open pull request makes the branch live however many closed ones sit beside it. With none
 * open, a merged or closed one ends it, and a pull request closed unmerged counts.
 */
export const fateOfPulls = (branch: string, pulls: ReadonlyArray<HeadPull>): BranchFate | null => {
	const open = pulls.find((pull) => pull.state === "open");
	if (open !== undefined) {
		return {_tag: "Live", because: `pull request #${open.number} on ${branch} is open`};
	}
	const newest = [...pulls].sort((a, b) => b.number - a.number)[0];
	const last = pulls.find((pull) => pull.merged) ?? newest;
	if (last === undefined) return null;
	return {
		_tag: "Ended",
		branch,
		because: `pull request #${last.number} on its branch ${branch} is ${last.merged ? "merged" : "closed unmerged"}`,
	};
};

const EPIC_RE = /^epic\/(\d+)$/;

/**
 * The issue or pull request number a branch's own name carries, or `null` when it carries none.
 *
 * Two grammars name one: a build lane branch (`./lane.ts`) and an epic's assembly branch.
 */
export const ticketOf = (branch: string): number | null => {
	const lane = parseLaneBranch(branch);
	if (lane !== null) return laneNumber(lane);
	const epic = EPIC_RE.exec(branch);
	return epic?.[1] === undefined ? null : Number.parseInt(epic[1], 10);
};

/** What the number a branch is named for proves, once no pull request has that branch as its head. */
export const fateOfTicket = (
	branch: string,
	ticket: {readonly number: number; readonly state: string},
): BranchFate =>
	ticket.state === "closed"
		? {
				_tag: "Ended",
				branch,
				because: `#${ticket.number}, which its branch ${branch} is named for, is closed`,
			}
		: {
				_tag: "Live",
				because: `#${ticket.number}, which ${branch} is named for, is open, and no pull request has that branch as its head`,
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

/** The license the trunk gives for a HEAD, or `null` when it does not carry it. */
const trunkLicense = (landing: Containment): License | null => {
	switch (landing._tag) {
		case "Ancestor":
			return "ancestor";
		case "Squashed":
			return "squashed";
		case "NoChange":
			return "no-change";
		default:
			return null;
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
