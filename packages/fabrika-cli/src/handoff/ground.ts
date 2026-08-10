/**
 * The ground state a pack embeds: nineteen digested fields derived from the git repository and the
 * board, plus the two undigested ones (`capturedAt`, `groundDigest`).
 *
 * <!-- anchor: A-FAILED-READ-IS-NEVER-A-VALUE --> **No field carries `unknown` to mean "the read
 * failed".** A git or board read that fails is a refusal for the whole verb — the ground is UNKNOWN
 * and no object is emitted. The one `unknown` in the set, `git.reachable`, is a **fact** about a
 * repository with no configured upstream, and `aheadBy` / `behindBy` are `null` in the same case for
 * the same reason. Conflating the two is how a guard vouches for a tree it never read (ADR 0092).
 *
 * <!-- anchor: THE-GROUND-EXCLUDES-WHAT-THIS-GROUP-WRITES --> The digested set excludes exactly the
 * fields this group's own writes move, and nothing more: the pack and the claim are comments, so
 * what a write of ours could move is the issue's `updated_at`, its comment count and its comment
 * ids — none of which is one of the nineteen. `capturedAt` is excluded for a different reason: it
 * differs on every derivation by construction, so digesting it would make drift permanently `moved`.
 *
 * The compared set is **sixteen** of the nineteen. Rows 11-13, the `git.tree.*` fields, are a
 * property of the working copy that took the pack rather than of the work, and no successor can
 * observe them — so they are digested (the pack attests the tree it was taken from) and not
 * compared.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {execCapture} from "../io/exec.ts";
import {type Attempt, fail, ok, resolveCommit, type Shell} from "../io/git.ts";
import {isRecord, parseJson} from "../io/json.ts";
import {listCheckRuns, pullsForBranch} from "../io/pulls.ts";
import {bodyDigest} from "../ledger/digest.ts";

/** Whether a successor can see the work. `unknown` is a fact about an unset upstream, not a failure. */
export type Reachable = "pushed" | "unpushed" | "unknown";
export type TreeStateWord = "clean" | "dirty";
export type ChecksWord = "passing" | "failing" | "pending" | "none";

/** Rows 3-10: the git state a successor re-derives against the packed branch. */
export interface GitCore {
	readonly branch: string;
	readonly head: string;
	readonly upstream: string | null;
	readonly reachable: Reachable;
	readonly aheadBy: number | null;
	readonly behindBy: number | null;
	readonly base: {readonly branch: string; readonly head: string};
}

/** Rows 11-13: the working copy that took the pack. Digested, never compared. */
export interface TreeState {
	readonly state: TreeStateWord;
	readonly trackedModified: number;
	readonly untracked: number;
}

/** Rows 14-19. `pull` is `null` when no pull request has this head ref — a fact, not an absence. */
export interface BoardState {
	readonly issue: {readonly state: string; readonly labels: ReadonlyArray<string>};
	readonly pull: {
		readonly number: number;
		readonly state: string;
		readonly head: string;
		readonly checks: ChecksWord;
	} | null;
}

export interface GroundState {
	readonly issue: number;
	readonly repo: string;
	readonly capturedAt: string;
	readonly git: GitCore & {readonly tree: TreeState};
	readonly board: BoardState;
	readonly groundDigest: string;
}

/** The nineteen digested fields, in the order the digest pre-image lists them. */
export const DIGESTED_FIELDS: ReadonlyArray<string> = [
	"issue",
	"repo",
	"git.branch",
	"git.head",
	"git.upstream",
	"git.reachable",
	"git.aheadBy",
	"git.behindBy",
	"git.base.branch",
	"git.base.head",
	"git.tree.state",
	"git.tree.trackedModified",
	"git.tree.untracked",
	"board.issue.state",
	"board.issue.labels",
	"board.pull.number",
	"board.pull.state",
	"board.pull.head",
	"board.pull.checks",
];

/** The sixteen a successor can observe. The three `git.tree.*` rows are digested and not compared. */
export const COMPARED_FIELDS: ReadonlyArray<string> = DIGESTED_FIELDS.filter(
	(field) => !field.startsWith("git.tree."),
);

/** What a comparison reads: the packed and the live record, minus what only the writer could see. */
export interface Comparable {
	readonly issue: number;
	readonly repo: string;
	readonly git: GitCore;
	readonly board: BoardState;
}

/**
 * One field's value, `null` for an absent one.
 *
 * A missing intermediate collapses to `null` rather than to `undefined`, which is what makes all
 * four `board.pull.*` rows read `null` together when `board.pull` is — the rule the digest
 * pre-image states.
 */
export const fieldAt = (source: object, path: string): unknown => {
	let current: unknown = source;
	for (const key of path.split(".")) {
		if (!isRecord(current)) return null;
		current = current[key];
	}
	return current === undefined ? null : current;
};

/** The digest pre-image: nineteen `<path>=<json>` lines, in order, LF-joined. */
export const preImage = (ground: {
	readonly issue: number;
	readonly repo: string;
	readonly git: GitCore & {readonly tree: TreeState};
	readonly board: BoardState;
}): string =>
	DIGESTED_FIELDS.map((field) => `${field}=${JSON.stringify(fieldAt(ground, field))}`).join("\n");

/** `bodyDigest` over the pre-image — the same function the ledger uses, over a different input. */
export const digestOf = (ground: Parameters<typeof preImage>[0]): string =>
	bodyDigest(preImage(ground));

export const comparableOf = (ground: GroundState): Comparable => ({
	issue: ground.issue,
	repo: ground.repo,
	git: ground.git,
	board: ground.board,
});

/** The JSON object a pack embeds, with its keys in the order the contract prints them. */
export const renderGround = (ground: GroundState): string =>
	JSON.stringify({
		issue: ground.issue,
		repo: ground.repo,
		capturedAt: ground.capturedAt,
		git: {
			branch: ground.git.branch,
			head: ground.git.head,
			upstream: ground.git.upstream,
			reachable: ground.git.reachable,
			aheadBy: ground.git.aheadBy,
			behindBy: ground.git.behindBy,
			base: ground.git.base,
			tree: ground.git.tree,
		},
		board: ground.board,
		groundDigest: ground.groundDigest,
	});

export type GroundParse =
	| {readonly _tag: "Ground"; readonly value: GroundState}
	| {readonly _tag: "Unusable"; readonly reason: string};

const isChecks = (value: unknown): value is ChecksWord =>
	value === "passing" || value === "failing" || value === "pending" || value === "none";

const isReachable = (value: unknown): value is Reachable =>
	value === "pushed" || value === "unpushed" || value === "unknown";

const isCount = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * Read a proven half back into the nineteen fields, refusing any shape that is not what was written.
 *
 * Every rejection is a refusal rather than a default. A permissive parse would let an edited pack
 * report a ground it never proved, which is exactly what the digest re-check exists to catch — and a
 * parse that filled a missing field in would make that re-check pass over the edit.
 */
export const parseGround = (text: string): GroundParse => {
	// Through `parseJson` rather than a raw `try/catch`: this module imports `effect`, where a native
	// throw is banned (#2736), and that boundary is exactly what `io/json.ts` exists to be.
	const parsed = parseJson(text);
	if (!isRecord(parsed)) return {_tag: "Unusable", reason: "the proven half is not one object"};
	const {issue, repo, capturedAt, groundDigest} = parsed;
	const git = parsed.git;
	const board = parsed.board;
	if (typeof issue !== "number" || typeof repo !== "string" || typeof capturedAt !== "string") {
		return {_tag: "Unusable", reason: "issue, repo or capturedAt is missing or not its shape"};
	}
	if (typeof groundDigest !== "string") {
		return {_tag: "Unusable", reason: "the proven half carries no groundDigest"};
	}
	if (!isRecord(git) || !isRecord(board)) {
		return {_tag: "Unusable", reason: "the proven half carries no git or no board object"};
	}
	const base = git.base;
	const tree = git.tree;
	if (!isRecord(base) || typeof base.branch !== "string" || typeof base.head !== "string") {
		return {_tag: "Unusable", reason: "git.base is missing its branch or head"};
	}
	if (
		!isRecord(tree) ||
		(tree.state !== "clean" && tree.state !== "dirty") ||
		!isCount(tree.trackedModified) ||
		!isCount(tree.untracked)
	) {
		return {_tag: "Unusable", reason: "git.tree is missing a field or carries one off its shape"};
	}
	if (typeof git.branch !== "string" || typeof git.head !== "string") {
		return {_tag: "Unusable", reason: "git.branch or git.head is missing"};
	}
	if (git.upstream !== null && typeof git.upstream !== "string") {
		return {_tag: "Unusable", reason: "git.upstream is neither a ref nor null"};
	}
	if (!isReachable(git.reachable)) {
		return {_tag: "Unusable", reason: "git.reachable is off its closed set"};
	}
	if (
		(git.aheadBy !== null && typeof git.aheadBy !== "number") ||
		(git.behindBy !== null && typeof git.behindBy !== "number")
	) {
		return {_tag: "Unusable", reason: "git.aheadBy or git.behindBy is neither a count nor null"};
	}
	const issueState = board.issue;
	if (!isRecord(issueState) || typeof issueState.state !== "string") {
		return {_tag: "Unusable", reason: "board.issue carries no state"};
	}
	const labels = issueState.labels;
	if (!Array.isArray(labels) || labels.some((label) => typeof label !== "string")) {
		return {_tag: "Unusable", reason: "board.issue.labels is not a list of names"};
	}
	const pullValue = board.pull;
	let pull: BoardState["pull"] = null;
	if (pullValue !== null) {
		if (
			!isRecord(pullValue) ||
			typeof pullValue.number !== "number" ||
			typeof pullValue.state !== "string" ||
			typeof pullValue.head !== "string" ||
			!isChecks(pullValue.checks)
		) {
			return {_tag: "Unusable", reason: "board.pull is neither null nor a whole pull-request row"};
		}
		pull = {
			number: pullValue.number,
			state: pullValue.state,
			head: pullValue.head,
			checks: pullValue.checks,
		};
	}
	return {
		_tag: "Ground",
		value: {
			issue,
			repo,
			capturedAt,
			git: {
				branch: git.branch,
				head: git.head,
				upstream: git.upstream,
				reachable: git.reachable,
				aheadBy: git.aheadBy,
				behindBy: git.behindBy,
				base: {branch: base.branch, head: base.head},
				tree: {
					state: tree.state,
					trackedModified: tree.trackedModified,
					untracked: tree.untracked,
				},
			},
			board: {issue: {state: issueState.state, labels: labels as ReadonlyArray<string>}, pull},
			groundDigest,
		},
	};
};

/** Per-field drift. `unknown` is reachable only for a field whose live value could not be derived. */
export type FieldDrift = "same" | "moved" | "unknown";

export interface DriftField {
	readonly field: string;
	readonly packed: unknown;
	readonly live: unknown;
	readonly state: FieldDrift;
}

/** The live side of a comparison. `git` is `null` when the packed branch is proven gone. */
export interface LiveGround {
	readonly issue: number;
	readonly repo: string;
	readonly git: GitCore | null;
	readonly board: BoardState;
}

/** The sixteen compared, field by field. Only the rows that are not `same` reach the answer. */
export const compareGround = (packed: Comparable, live: LiveGround): ReadonlyArray<DriftField> =>
	COMPARED_FIELDS.map((field) => {
		const packedValue = fieldAt(packed, field);
		if (live.git === null && field.startsWith("git.")) {
			// The packed branch is gone, so rows 3-10 have no live value at all. `moved` rather than
			// `unknown`: the ref's absence is proven, not a read that failed — and reporting a null
			// upstream as `same` against a branch nobody can check out would be the fail-open reading.
			return {field, packed: packedValue, live: null, state: "moved" as const};
		}
		const liveValue = fieldAt(live, field);
		return {
			field,
			packed: packedValue,
			live: liveValue,
			state:
				JSON.stringify(packedValue) === JSON.stringify(liveValue)
					? ("same" as const)
					: ("moved" as const),
		};
	});

/**
 * The document-level token, which is the **worst** of the per-field states.
 *
 * Its closed set is deliberately not the per-field one: a document whose every field compared equal
 * reads `none`, where a field that compared equal reads `same`. Same fact, two vocabularies, because
 * one is about a comparison and the other about the whole record.
 */
export type DocumentDrift = "none" | "moved" | "unknown";

export const driftState = (fields: ReadonlyArray<DriftField>): DocumentDrift =>
	fields.some((row) => row.state === "unknown")
		? "unknown"
		: fields.some((row) => row.state === "moved")
			? "moved"
			: "none";

// -------------------------------------------------------------------------------------------
// Derivation. Every read below goes through `execCapture`, where a non-zero exit is data.
// -------------------------------------------------------------------------------------------

/** The `git.tree.*` counts, from one porcelain read. A read that fails is never a clean tree. */
export const deriveTree: Shell<Attempt<TreeState>> = Effect.gen(function* () {
	const r = yield* execCapture("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
	if (!r.ok) return fail(r.reason);
	const lines = r.stdout.split("\n").filter((line) => line.trim() !== "");
	const untracked = lines.filter((line) => line.startsWith("??")).length;
	return ok({
		state: lines.length === 0 ? ("clean" as const) : ("dirty" as const),
		trackedModified: lines.length - untracked,
		untracked,
	});
});

/** The counts `git rev-list --left-right --count <a>...<b>` prints: left is behind, right is ahead. */
export const parseAheadBehind = (
	stdout: string,
): {readonly behindBy: number; readonly aheadBy: number} | null => {
	const parts = stdout.trim().split(/\s+/);
	const behind = parts[0] ?? "";
	const ahead = parts[1] ?? "";
	if (parts.length !== 2 || !/^\d+$/.test(behind) || !/^\d+$/.test(ahead)) return null;
	return {behindBy: Number.parseInt(behind, 10), aheadBy: Number.parseInt(ahead, 10)};
};

/**
 * Rows 3-10, derived against `ref`.
 *
 * <!-- anchor: READ-DERIVES-AGAINST-THE-PACKED-BRANCH --> `capture` passes `null` and derives
 * against `HEAD`; `read` passes the **pack's own branch**, never the successor's `HEAD`. A successor
 * is by construction a different checkout — usually a fresh worktree on the default branch — so
 * deriving from `HEAD` there would report the successor's own location as drift and mark eight rows
 * moved on a perfectly current pack.
 */
export const deriveGitCore = (options: {
	readonly ref: string | null;
	readonly base: string;
}): Shell<Attempt<GitCore>> =>
	Effect.gen(function* () {
		const ref = options.ref ?? "HEAD";
		let branch = options.ref;
		if (branch === null) {
			const named = yield* execCapture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
			if (!named.ok) return fail(named.reason);
			branch = named.stdout.trim();
			if (branch === "") return fail("git named no branch for HEAD");
		}

		const head = yield* resolveCommit(ref);
		if (head._tag === "Failure") return head;

		const named = yield* execCapture("git", [
			"rev-parse",
			"--abbrev-ref",
			"--symbolic-full-name",
			`${ref}@{u}`,
		]);
		// A non-zero exit here is the fact "no upstream is configured", which is what rows 6-8 read as
		// `unknown` / `null` / `null`. It is not a failed read: the ref itself already resolved.
		const upstream = named.ok && named.stdout.trim() !== "" ? named.stdout.trim() : null;

		let reachable: Reachable = "unknown";
		let aheadBy: number | null = null;
		let behindBy: number | null = null;
		if (upstream !== null) {
			const ancestor = yield* execCapture("git", [
				"merge-base",
				"--is-ancestor",
				ref,
				`${ref}@{u}`,
			]);
			reachable = ancestor.ok ? "pushed" : "unpushed";
			const counted = yield* execCapture("git", [
				"rev-list",
				"--left-right",
				"--count",
				`${ref}@{u}...${ref}`,
			]);
			if (!counted.ok) return fail(counted.reason);
			const counts = parseAheadBehind(counted.stdout);
			if (counts === null) {
				return fail(`git rev-list printed "${counted.stdout.trim()}", which is not two counts`);
			}
			aheadBy = counts.aheadBy;
			behindBy = counts.behindBy;
		}

		const baseHead = yield* resolveCommit(options.base);
		if (baseHead._tag === "Failure") return baseHead;

		return ok({
			branch,
			head: head.value,
			upstream,
			reachable,
			aheadBy,
			behindBy,
			base: {branch: options.base, head: baseHead.value},
		});
	});

/** Row 19, from the check runs at a head. An unread rollup is a failure, never `none`. */
export const deriveChecks = (repo: string, sha: string): Shell<Attempt<ChecksWord>> =>
	Effect.gen(function* () {
		const rollup = yield* listCheckRuns(repo, sha);
		if (rollup._tag === "Failure") return rollup;
		const runs = rollup.value.runs;
		if (runs.some((run) => ["failure", "cancelled", "timed_out"].includes(run.conclusion ?? ""))) {
			return ok("failing" as const);
		}
		if (runs.some((run) => run.status === "queued" || run.status === "in_progress")) {
			return ok("pending" as const);
		}
		return ok(
			runs.some((run) => run.conclusion === "success") ? ("passing" as const) : ("none" as const),
		);
	});

/** Whether the packed branch still names a commit. The precondition every rows-3-10 comparison rests on. */
export type BranchResolution = "resolves" | "gone" | "unknown";

/**
 * Resolve a branch three ways.
 *
 * `gone` is only reported once the repository itself is proven readable — otherwise a broken
 * checkout would report every branch as deleted, which is the fail-open direction for a successor
 * deciding whether the work still exists.
 */
export const resolveBranch = (branch: string): Shell<BranchResolution> =>
	Effect.gen(function* () {
		const named = yield* execCapture("git", [
			"rev-parse",
			"--verify",
			"--quiet",
			`${branch}^{commit}`,
		]);
		if (named.ok && named.stdout.trim() !== "") return "resolves" as const;
		const inside = yield* execCapture("git", ["rev-parse", "--is-inside-work-tree"]);
		return inside.ok && inside.stdout.trim() === "true" ? ("gone" as const) : ("unknown" as const);
	});

/** Rows 16-19: the most recently created pull request on `branch`, or the fact that there is none. */
export const derivePull = (repo: string, branch: string): Shell<Attempt<BoardState["pull"]>> =>
	Effect.gen(function* () {
		const pulls = yield* pullsForBranch(repo, branch);
		if (pulls._tag === "Failure") return pulls;
		const newest = [...pulls.value].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
		if (newest === undefined) return ok(null);
		const checks = yield* deriveChecks(repo, newest.headSha);
		if (checks._tag === "Failure") return checks;
		return ok({
			number: newest.number,
			state: newest.mergedAt === null ? newest.state : "merged",
			head: newest.headSha,
			checks: checks.value,
		});
	});

/** Which half of the ground could not be read, so the refusal names a remedy rather than a stack. */
export type GroundFailure =
	| {readonly kind: "git"; readonly reason: string}
	| {readonly kind: "board"; readonly reason: string};

export type GroundDerivation =
	| {readonly _tag: "Ground"; readonly value: GroundState}
	| {readonly _tag: "Failed"; readonly failure: GroundFailure};

export interface DeriveOptions {
	readonly repo: string;
	readonly issue: number;
	/** The branch to derive rows 3-10 against, or `null` for `HEAD`. */
	readonly ref: string | null;
	readonly base: string;
	/** The live issue, already read by the caller — so a 404 refuses `7` rather than `11` here. */
	readonly board: {readonly state: string; readonly labels: ReadonlyArray<string>};
	readonly now: () => Date;
}

/**
 * The whole ground state, derived. Either the object or a refusal — there is no partial answer.
 *
 * A git read that fails is a refusal, **never a clean tree**: reporting `clean` over a failed
 * `git status` is the zero-scope pass ADR 0092 forbids, and here it would license a pack asserting
 * reachable work that is not reachable.
 */
export const deriveGround = (
	options: DeriveOptions,
): Effect.Effect<GroundDerivation, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const core = yield* deriveGitCore({ref: options.ref, base: options.base});
		if (core._tag === "Failure") {
			return {_tag: "Failed" as const, failure: {kind: "git" as const, reason: core.reason}};
		}
		const tree = yield* deriveTree;
		if (tree._tag === "Failure") {
			return {_tag: "Failed" as const, failure: {kind: "git" as const, reason: tree.reason}};
		}
		const pull = yield* derivePull(options.repo, core.value.branch);
		if (pull._tag === "Failure") {
			return {_tag: "Failed" as const, failure: {kind: "board" as const, reason: pull.reason}};
		}

		const withoutDigest = {
			issue: options.issue,
			repo: options.repo,
			git: {...core.value, tree: tree.value},
			board: {
				issue: {state: options.board.state, labels: [...options.board.labels].sort()},
				pull: pull.value,
			},
		};
		return {
			_tag: "Ground" as const,
			value: {
				...withoutDigest,
				capturedAt: options
					.now()
					.toISOString()
					.replace(/\.\d{3}Z$/, "Z"),
				groundDigest: digestOf(withoutDigest),
			},
		};
	});

/**
 * The board half alone, for a pack whose branch is proven gone.
 *
 * The pull request is still selected by the **packed** branch's head ref: a deleted local branch
 * says nothing about the pull request it opened, and reporting those four rows as unreadable would
 * hide the one place a successor can still see what happened to the work.
 */
export const deriveLiveBoard = (options: {
	readonly repo: string;
	readonly issue: number;
	readonly branch: string;
	readonly board: {readonly state: string; readonly labels: ReadonlyArray<string>};
}): Effect.Effect<
	| {readonly _tag: "Live"; readonly value: LiveGround}
	| {
			readonly _tag: "Failed";
			readonly failure: GroundFailure;
	  },
	never,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const pull = yield* derivePull(options.repo, options.branch);
		if (pull._tag === "Failure") {
			return {_tag: "Failed" as const, failure: {kind: "board" as const, reason: pull.reason}};
		}
		return {
			_tag: "Live" as const,
			value: {
				issue: options.issue,
				repo: options.repo,
				git: null,
				board: {
					issue: {state: options.board.state, labels: [...options.board.labels].sort()},
					pull: pull.value,
				},
			},
		};
	});

export type ComparableDerivation =
	| {readonly _tag: "Comparable"; readonly value: Comparable}
	| {readonly _tag: "Failed"; readonly failure: GroundFailure};

/**
 * The **sixteen** a successor can observe, derived live against the packed branch.
 *
 * Deliberately not `deriveGround` with the tree thrown away: the three `git.tree.*` rows describe
 * the working copy that took the pack, so a successor reading its *own* tree would be measuring a
 * different machine — and a fabricated `clean` would be worse still, since it would ride into a
 * digest nobody asked for.
 */
export const deriveComparable = (options: {
	readonly repo: string;
	readonly issue: number;
	readonly ref: string;
	readonly base: string;
	readonly board: {readonly state: string; readonly labels: ReadonlyArray<string>};
}): Effect.Effect<ComparableDerivation, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const core = yield* deriveGitCore({ref: options.ref, base: options.base});
		if (core._tag === "Failure") {
			return {_tag: "Failed" as const, failure: {kind: "git" as const, reason: core.reason}};
		}
		const pull = yield* derivePull(options.repo, core.value.branch);
		if (pull._tag === "Failure") {
			return {_tag: "Failed" as const, failure: {kind: "board" as const, reason: pull.reason}};
		}
		return {
			_tag: "Comparable" as const,
			value: {
				issue: options.issue,
				repo: options.repo,
				git: core.value,
				board: {
					issue: {state: options.board.state, labels: [...options.board.labels].sort()},
					pull: pull.value,
				},
			},
		};
	});
