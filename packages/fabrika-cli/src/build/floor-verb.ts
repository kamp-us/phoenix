/**
 * `build floor` — who holds the primary checkout's floor, as a verb answer instead of a chat relay.
 *
 * A worktree-isolated spawn refuses while the primary checkout holds any uncommitted change, and
 * that refusal names no writer. This reads the same dirty set and pairs each path with the lane
 * branches that could own it, each carrying what the board says about its claim.
 *
 * **It writes nothing, on any path.** Every git call carries `--no-optional-locks`, because a plain
 * `git status` refreshes the index it reads — a write into the very checkout it reports on. The
 * board is only read, through the claim fold `build claimants` resolves against.
 *
 * **An unread claim is UNKNOWN for the whole answer.** A candidate list whose claim states are
 * partly missing reads as "these branches are residue", which is the misattribution this verb
 * exists to stop — so an unreadable claim refuses on `11` and never names a guessed owner.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/7057
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {execCapture} from "../io/exec.ts";
import {originHeadRef} from "../io/git.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {type Claimants, readClaimants} from "./claim.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {
	byStrength,
	claimStateOf,
	type DirtyPath,
	type Owner,
	ownerOf,
	pairPaths,
	parseGraph,
	parseStatus,
	parseTips,
	parseTouches,
} from "./floor.ts";
import {worktreeRegistrations} from "./git.ts";
import {laneNumber} from "./lane.ts";
import {resolveTargetRepo} from "./target.ts";

const VERB = "build floor";

/** The harness gate's one exclusion: its own subagent state, which it writes into the checkout. */
const HARNESS_STATE = ":(exclude).pi/subagents";

export interface FloorOptions {
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

const git = (root: string, args: ReadonlyArray<string>) =>
	execCapture("git", ["-C", root, "--no-optional-locks", ...args]);

const unknown = (what: string, reason: string): VerbOutcome =>
	refuse(
		PRECONDITION_UNKNOWN,
		`${VERB}: cannot read ${what}: ${reason} — who holds the floor is UNKNOWN, never a guessed name.`,
	);

/** The paths a branch's commits are compared against: each dirty path, and a rename's source. */
const pathspecs = (dirty: ReadonlyArray<DirtyPath>): ReadonlyArray<string> => [
	...new Set(
		dirty.flatMap((entry) => (entry.origin === null ? [entry.path] : [entry.path, entry.origin])),
	),
];

const ownerLine = (owner: Owner): string =>
	`${owner.branch} (${owner.kind === "pr" ? "PR " : ""}#${String(owner.number)}, ${owner.evidence.join(" + ")}, claim ${owner.claim})`;

export const runFloor = (
	options: FloorOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const registrations = yield* worktreeRegistrations;
		if (registrations._tag === "Failure") {
			return unknown("this clone's worktrees", registrations.reason);
		}
		// git lists the main worktree first, whichever worktree asks.
		const primary = registrations.value[0];
		if (primary === undefined) {
			return unknown("this clone's worktrees", "`git worktree list` named no main worktree");
		}

		const status = yield* git(primary.path, [
			"status",
			"--porcelain=v1",
			"-z",
			"--",
			".",
			HARNESS_STATE,
		]);
		if (!status.ok)
			return unknown(`the primary checkout's status at ${primary.path}`, status.reason);
		const dirty = parseStatus(status.stdout);
		if (dirty.length === 0) {
			return answer(
				JSON.stringify({answer: "free", primary: primary.path, head: primary.branch, paths: []}),
				[
					`${VERB}: the primary checkout at ${primary.path} holds no uncommitted change — the floor is free.`,
				],
			);
		}

		const trunk = yield* originHeadRef;
		if (trunk._tag === "Failure") return unknown("this clone's trunk", trunk.reason);
		const remote = trunk.value.split("/")[0] ?? "origin";
		// A lane's own commits: on some lane branch, and on neither the trunk nor an assembly branch.
		const bound = ["--branches=build/*", "--not", trunk.value, `--remotes=${remote}/epic/*`];

		const tips = yield* git(primary.path, [
			"for-each-ref",
			"--format=%(objectname) %(refname:short)",
			"refs/heads/build/",
		]);
		if (!tips.ok) return unknown("this clone's lane branches", tips.reason);
		const graph = yield* git(primary.path, ["log", "--format=%H %P", ...bound]);
		if (!graph.ok) return unknown("the lane branches' commits", graph.reason);
		const touches = yield* git(primary.path, [
			"--literal-pathspecs",
			"log",
			"--full-history",
			"--format=%x01%H",
			"--name-only",
			"-z",
			...bound,
			"--",
			...pathspecs(dirty),
		]);
		if (!touches.ok) return unknown("which lane commits touch the dirty paths", touches.reason);

		const pairings = pairPaths({
			dirty,
			head: primary.branch,
			tips: parseTips(tips.stdout),
			graph: parseGraph(graph.stdout),
			touches: parseTouches(touches.stdout),
		});

		const numbers = [
			...new Set(pairings.flatMap((pairing) => pairing.candidates.map((c) => laneNumber(c.lane)))),
		].sort((left, right) => left - right);
		const claims = new Map<number, Extract<Claimants, {_tag: "Read"}>>();
		if (numbers.length > 0) {
			const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
			if (resolved._tag === "Refused") return resolved.outcome;
			for (const number of numbers) {
				const read = yield* readClaimants(resolved.repo, number);
				if (read._tag === "Unknown")
					return unknown(`the claim markers on #${String(number)}`, read.reason);
				claims.set(number, read);
			}
		}

		const paths = pairings.map(({dirty: entry, candidates}) => ({
			path: entry.path,
			status: entry.status,
			origin: entry.origin,
			owners: candidates
				.flatMap((candidate) => {
					const read = claims.get(laneNumber(candidate.lane));
					return read === undefined ? [] : [ownerOf(candidate, claimStateOf(candidate.lane, read))];
				})
				.sort(byStrength),
		}));
		const unowned = paths.filter((row) => row.owners.length === 0);
		return answer(
			JSON.stringify({answer: "held", primary: primary.path, head: primary.branch, paths}),
			[
				`${VERB}: the primary checkout at ${primary.path} holds ${String(dirty.length)} uncommitted path(s); read ${String(numbers.length)} candidate lane(s)' claims.`,
				...paths.map((row) => {
					const [first, ...rest] = row.owners;
					return first === undefined
						? `${VERB}: ${row.path} — no claim and no lane branch reaches it; no owner is named.`
						: `${VERB}: ${row.path} — strongest candidate ${ownerLine(first)}${rest.length === 0 ? "" : `, ${String(rest.length)} more`}.`;
				}),
				...(unowned.length === 0
					? []
					: [
							`${VERB}: ${String(unowned.length)} path(s) have no candidate — a dead session's residue and a live sibling's work read the same here; ask, never clean.`,
						]),
			],
		);
	});
