/**
 * Who holds the primary checkout's floor: its uncommitted paths, each paired with the lanes the
 * evidence names as candidate owners.
 *
 * The decision core of `build floor`, pure over facts the verb has already read. Nothing here runs
 * git or reads the board, so every pairing and every ranking is testable as a value.
 *
 * **A candidate is evidence, never an attribution.** Two facts name a lane branch against a dirty
 * path: the primary checkout has that branch checked out, or the branch's own commits touch that
 * path. A path neither fact reaches gets no owner at all — never the nearest branch, never the
 * checked-out lane's issue guessed from a filename — because a wrong name sends a human to ask the
 * wrong session to commit its work.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/7057
 */
import type {Claimants} from "./claim.ts";
import {type LaneBranch, laneNumber, nonceOf, parseLaneBranch} from "./lane.ts";

/** One entry of `git status --porcelain -z`: the two-letter code, the path, and a rename's source. */
export interface DirtyPath {
	readonly status: string;
	/** Root-relative. An untracked directory git collapsed keeps its trailing `/`. */
	readonly path: string;
	/** The path a rename or copy came from, else `null`. */
	readonly origin: string | null;
}

/**
 * Parse `git status --porcelain=v1 -z`.
 *
 * `-z` is what keeps a path with a space or a quote in the spelling a branch's own diff prints; the
 * quoted default would match nothing. A rename or copy spends a second NUL-terminated field on its
 * source.
 */
export const parseStatus = (stdout: string): ReadonlyArray<DirtyPath> => {
	const fields = stdout.split("\0");
	const entries: DirtyPath[] = [];
	for (let at = 0; at < fields.length; at += 1) {
		const field = fields[at] ?? "";
		if (field.length < 4) continue;
		const status = field.slice(0, 2);
		const path = field.slice(3);
		const moved = status.includes("R") || status.includes("C");
		const origin = moved ? (fields[at + 1] ?? null) : null;
		if (moved) at += 1;
		entries.push({status, path, origin: origin === "" ? null : origin});
	}
	return entries;
};

/** A local lane branch and the commit it points at. */
export interface LaneTip {
	readonly branch: string;
	readonly lane: LaneBranch;
	readonly tip: string;
}

/** Parse `git for-each-ref --format='%(objectname) %(refname:short)'`, keeping lane branches only. */
export const parseTips = (stdout: string): ReadonlyArray<LaneTip> =>
	stdout.split("\n").flatMap((line) => {
		const [tip, branch] = line.trim().split(/\s+/);
		if (tip === undefined || branch === undefined) return [];
		const lane = parseLaneBranch(branch);
		return lane === null ? [] : [{branch, lane, tip}];
	});

/**
 * Parse `git log --format='%H %P'` into commit → parents.
 *
 * The log is bounded by the trunk and the assembly branches, so a parent missing from the map is a
 * commit some lane shares with the base — where a walk stops.
 */
export const parseGraph = (stdout: string): ReadonlyMap<string, ReadonlyArray<string>> => {
	const graph = new Map<string, ReadonlyArray<string>>();
	for (const line of stdout.split("\n")) {
		const [sha, ...parents] = line.trim().split(/\s+/);
		if (sha !== undefined && sha !== "") graph.set(sha, parents);
	}
	return graph;
};

/** Parse `git log --format=%x01%H --name-only -z` into commit → the paths it touches. */
export const parseTouches = (stdout: string): ReadonlyMap<string, ReadonlyArray<string>> => {
	const touches = new Map<string, ReadonlyArray<string>>();
	for (const record of stdout.split("\x01")) {
		const [sha, ...paths] = record.split("\0").map((field) => field.replace(/^\n/, ""));
		if (sha === undefined || sha === "") continue;
		touches.set(
			sha,
			paths.filter((path) => path !== ""),
		);
	}
	return touches;
};

/** Every commit reachable from `tip` inside `graph`. */
const reachable = (
	tip: string,
	graph: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlySet<string> => {
	const seen = new Set<string>();
	const pending = [tip];
	for (let sha = pending.pop(); sha !== undefined; sha = pending.pop()) {
		if (seen.has(sha)) continue;
		const parents = graph.get(sha);
		if (parents === undefined) continue;
		seen.add(sha);
		pending.push(...parents);
	}
	return seen;
};

/** Whether a branch touching `touched` explains the dirty entry. */
const covers = (dirty: DirtyPath, touched: string): boolean =>
	touched === dirty.path ||
	touched === dirty.origin ||
	(dirty.path.endsWith("/") && touched.startsWith(dirty.path));

/** What names a lane branch as a candidate for one path. */
export type Evidence = "checked-out" | "touches-path";

/** A lane branch the evidence reaches, before its claim is read. */
export interface Candidate {
	readonly branch: string;
	readonly lane: LaneBranch;
	readonly evidence: ReadonlyArray<Evidence>;
}

export interface Pairing {
	readonly dirty: DirtyPath;
	readonly candidates: ReadonlyArray<Candidate>;
}

export interface FloorFacts {
	readonly dirty: ReadonlyArray<DirtyPath>;
	/** The branch the primary checkout has checked out, `null` when its HEAD is detached. */
	readonly head: string | null;
	readonly tips: ReadonlyArray<LaneTip>;
	readonly graph: ReadonlyMap<string, ReadonlyArray<string>>;
	readonly touches: ReadonlyMap<string, ReadonlyArray<string>>;
}

/** Pair every dirty path with the lane branches the two evidence facts reach. */
export const pairPaths = (facts: FloorFacts): ReadonlyArray<Pairing> => {
	const reached = facts.tips.map((tip) => ({tip, commits: reachable(tip.tip, facts.graph)}));
	const carriers = new Map<string, number>();
	for (const {commits} of reached) {
		for (const sha of commits) carriers.set(sha, (carriers.get(sha) ?? 0) + 1);
	}
	// A commit only one lane branch carries is that lane's own. One several carry cannot be pinned on
	// any of them — and on a clone whose old branches were cut from history the trunk no longer
	// carries, that shared history is thousands of trunk-titled commits every old branch reaches.
	const touchedBy = reached.map(({tip, commits}) => {
		const paths = new Set<string>();
		for (const sha of commits) {
			if (carriers.get(sha) !== 1) continue;
			for (const path of facts.touches.get(sha) ?? []) paths.add(path);
		}
		return {tip, paths};
	});
	return facts.dirty.map((dirty) => {
		const candidates: Candidate[] = [];
		for (const {tip, paths} of touchedBy) {
			const evidence: Evidence[] = [];
			if (tip.branch === facts.head) evidence.push("checked-out");
			if ([...paths].some((touched) => covers(dirty, touched))) evidence.push("touches-path");
			if (evidence.length > 0) candidates.push({branch: tip.branch, lane: tip.lane, evidence});
		}
		return {dirty, candidates};
	});
};

/**
 * What the board says about a candidate branch's lane.
 *
 * `standing`: the number's authorized holder carries this branch's nonce — a live lane. `another-lane`:
 * the holder carries a different nonce, so this branch is an earlier lane's. `unclaimed`: no authorized
 * marker stands, which is what a released lane's leftover branch reads as.
 */
export type ClaimState =
	| {readonly state: "standing"; readonly holder: string}
	| {readonly state: "another-lane"; readonly holder: string}
	| {readonly state: "unclaimed"; readonly holder: null};

/** Fold one number's claim read against a branch's nonce. `Unknown` never reaches here. */
export const claimStateOf = (
	lane: LaneBranch,
	read: Extract<Claimants, {_tag: "Read"}>,
): ClaimState => {
	if (read.holder === null) return {state: "unclaimed", holder: null};
	return nonceOf(read.holder.token) === lane.nonce
		? {state: "standing", holder: read.holder.token}
		: {state: "another-lane", holder: read.holder.token};
};

export interface Owner {
	readonly branch: string;
	readonly number: number;
	readonly kind: "issue" | "pr";
	readonly evidence: ReadonlyArray<Evidence>;
	readonly claim: ClaimState["state"];
	readonly holder: string | null;
}

const EVIDENCE_WEIGHT: Readonly<Record<Evidence, number>> = {"checked-out": 2, "touches-path": 1};
const CLAIM_WEIGHT: Readonly<Record<ClaimState["state"], number>> = {
	standing: 2,
	"another-lane": 1,
	unclaimed: 0,
};

const evidenceWeight = (owner: Owner): number =>
	owner.evidence.reduce((sum, evidence) => sum + EVIDENCE_WEIGHT[evidence], 0);

/** Strongest first: evidence, then how live the claim is, then the branch name for a stable order. */
export const byStrength = (left: Owner, right: Owner): number =>
	evidenceWeight(right) - evidenceWeight(left) ||
	CLAIM_WEIGHT[right.claim] - CLAIM_WEIGHT[left.claim] ||
	left.branch.localeCompare(right.branch);

/** A candidate with its claim read folded in. */
export const ownerOf = (candidate: Candidate, claim: ClaimState): Owner => ({
	branch: candidate.branch,
	number: laneNumber(candidate.lane),
	kind: candidate.lane._tag === "Create" ? "issue" : "pr",
	evidence: candidate.evidence,
	claim: claim.state,
	holder: claim.holder,
});
