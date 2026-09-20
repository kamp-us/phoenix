/**
 * `lane refresh` — merge the trunk into an epic run's assembly branch, so the tail's review binds to
 * a head the merge queue can take.
 *
 * Nothing else in this package touches trunk after the first cut. `lane assembly` fetches `origin`
 * and cuts `epic/<n>` off `origin/HEAD` once; a resume fetches only to judge whether that branch is
 * already contained in the trunk, and merges nothing. So the branch drifts behind
 * trunk with nothing to notice, the queue ejects the tail, and `lane integrate` then reds on what is
 * really staleness. `lane push` names "fetch and re-merge" as the remedy for its exit 29 and no verb
 * performed it — this is that verb.
 *
 * A clean merge is silent: the branch moves and nothing parks. A real conflict aborts, resets
 * through `ORIG_HEAD` and **proves** the reset by re-reading HEAD, the same way `integrate`'s
 * `restore()` does — a branch that will not go back is UNKNOWN at {@link APPEND_UNKNOWN}, never the
 * clean {@link MERGE_CONFLICT} refusal, because it may still carry the merge no verdict admits.
 *
 * Two callers reach it automatically — the tail's way into review, and `lane dispatch` before it
 * cuts a child's worktree off the branch — and each is gated by its own `assemblyRefresh` arm
 * ({@link RefreshGate}). A driver typing the verb passes no gate and is never declined.
 *
 * Nothing is pushed here and no lane log is written: publishing the refreshed head is `lane push`'s
 * and recording the park is the driver's. On exit 0 the last stdout line is
 * `REFRESH-VERDICT: MERGED` or `REFRESH-VERDICT: CURRENT`, and the line above it the head.
 */
import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {ASSEMBLY_REFRESH, type AssemblyRefreshSurface} from "../config/keys/assembly-refresh.ts";
import type {Read} from "../config/read-key.ts";
import {execCapture} from "../io/exec.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {epicBranch} from "../wire/lane-brief.ts";
import {assemblySeat, worktrees} from "./assembly.ts";
import {
	APPEND_UNKNOWN,
	ASSEMBLY_DIRTY,
	ASSEMBLY_UNSEATED,
	KEY_MALFORMED,
	LANE_UNREADABLE,
	MERGE_CONFLICT,
	PRIMARY_CHECKOUT,
	PROOF_ABSENT,
} from "./codes.ts";
import {loadRefusal} from "./refusals.ts";
import {type LaneRef, loadLane} from "./store.ts";

const VERB = "fabrika lane refresh";

/** The cause a conflict parks under — `lane report --cause`'s closed set, never composed here. */
export const REFRESH_PARK_CAUSE = "assembly-conflict";

/** The trunk every automatic call merges in, unless an adapter's caller named another `--base`. */
export const DEFAULT_TRUNK_REF = "origin/main";

/**
 * Which automatic call this is — the `assemblyRefresh` sub-key that gates it, spelled as the key's
 * own field name so the gate cannot be read off one arm and reported as the other.
 *
 * `null` is a driver typing the verb, which is never gated. A single field rather than one boolean
 * per call site, because "this is both calls at once" is not a thing a caller can mean.
 */
export type RefreshGate = keyof AssemblyRefreshSurface;

const DECLINED: Readonly<Record<RefreshGate, string>> = {
	onReview: "--on-review",
	onDispatch: "the pre-dispatch refresh inside `lane dispatch`",
};

const KEPT: Readonly<Record<RefreshGate, string>> = {
	onReview: "the tail's path into review is the one it has today",
	onDispatch: "a child shell is cut from exactly the branch it would have been cut from before",
};

export interface RefreshOptions extends LaneRef {
	readonly epic: number;
	/** The ref to merge in. Defaults to {@link DEFAULT_TRUNK_REF} at the adapter, never guessed here. */
	readonly base: string;
	/**
	 * Which automatic call this is, or `null` for a driver typing the verb.
	 *
	 * An automatic call is what the matching `assemblyRefresh` arm gates; a hand call is never gated,
	 * because a driver that types the verb means it.
	 */
	readonly gate: RefreshGate | null;
	/** The repo's declared `assemblyRefresh`, read off `.fabrika.jsonc` by the adapter. */
	readonly assemblyRefresh: Read<AssemblyRefreshSurface>;
}

/** Diagnostics are the conflict's own; 40 lines is what a refusal can carry without burying it. */
const DIAGNOSTIC_LINES = 40;

const diagnostics = (output: string): ReadonlyArray<string> => {
	const lines = output.split("\n").filter((line) => line.trim() !== "");
	return lines.length <= DIAGNOSTIC_LINES
		? lines
		: [
				...lines.slice(0, DIAGNOSTIC_LINES),
				`… ${lines.length - DIAGNOSTIC_LINES} more line(s); re-run the command itself for the rest.`,
			];
};

const headOf = (path: string) =>
	Effect.map(execCapture("git", ["-C", path, "rev-parse", "HEAD"]), (read) =>
		read.ok
			? ({_tag: "Read", sha: read.stdout.trim()} as const)
			: ({_tag: "Unreadable", reason: read.reason} as const),
	);

const trackedChanges = (path: string) =>
	Effect.map(
		execCapture("git", ["-C", path, "status", "--porcelain", "--untracked-files=no"]),
		(read) =>
			read.ok
				? ({
						_tag: "Read",
						paths: read.stdout.split("\n").filter((line) => line.trim() !== ""),
					} as const)
				: ({_tag: "Unreadable", reason: read.reason} as const),
	);

/**
 * Put the assembly branch back where the merge found it, and prove it went.
 *
 * The re-read of HEAD against the sha captured before the merge is what makes the reset an answer
 * rather than a claim, exactly as in `integrate-verb.ts`. A branch that will not go back is UNKNOWN.
 */
const restore = (
	path: string,
	head: string,
	outcome: VerbOutcome,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const reset = yield* execCapture("git", ["-C", path, "reset", "--hard", "ORIG_HEAD"]);
		const after = yield* headOf(path);
		if (after._tag === "Unreadable") {
			return refuse(
				APPEND_UNKNOWN,
				`${VERB}: reset ${path} to ORIG_HEAD and cannot re-read its HEAD: ${after.reason} — whether the assembly branch still carries the merge is UNKNOWN.`,
				outcome.stderr,
			);
		}
		if (after.sha !== head) {
			return refuse(
				APPEND_UNKNOWN,
				`${VERB}: ${path} is at ${after.sha}, not the pre-merge ${head}${reset.ok ? "" : `: ${reset.reason}`} — the assembly branch still carries the merge; it was NOT restored.`,
				outcome.stderr,
			);
		}
		return {
			...outcome,
			stderr: [...outcome.stderr, `${VERB}: reset ${path} back to ${head}; nothing was pushed.`],
		};
	});

export const runRefresh = (
	options: RefreshOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		if (options.assemblyRefresh._tag === "Refused") {
			return refuse(
				KEY_MALFORMED,
				`${VERB}: ${options.assemblyRefresh.reason} — whether this repo refreshes its assembly branch is UNKNOWN, so nothing was merged.`,
			);
		}
		const gate = options.gate;
		if (gate !== null && options.assemblyRefresh.value[gate] === "off") {
			return answer(`REFRESH-VERDICT: DECLINED\n`, [
				`${VERB}: ${DECLINED[gate]} under ${options.assemblyRefresh.note}, whose \`${gate}\` reads off — nothing was fetched, merged or read, so ${KEPT[gate]}. Declare \`${ASSEMBLY_REFRESH}.${gate}: "on"\` to perform it, or call \`${VERB} ${options.epic}\` by hand, which is never gated.`,
			]);
		}

		const loaded = yield* loadLane(options);
		if (loaded._tag !== "Loaded") return loadRefusal(VERB, loaded);

		const branch = epicBranch(options.epic);
		const listed = yield* worktrees;
		if (listed._tag === "Failure") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read this repository's working trees: ${listed.reason} — where ${branch} is checked out is UNKNOWN, so nothing was merged.`,
			);
		}
		const seat = assemblySeat(listed.value, options.epic, branch);
		if (seat._tag === "Conscripted") {
			return refuse(
				PRIMARY_CHECKOUT,
				`${VERB}: ${branch} is checked out in the main working tree (${seat.path}) — a refresh never merges into the driver's checkout. Switch that tree off ${branch} and place the run's own with \`fabrika lane assembly ${options.epic}\`.`,
			);
		}
		if (seat._tag !== "Isolated") {
			return refuse(
				ASSEMBLY_UNSEATED,
				`${VERB}: no working tree holds ${branch} — place the run's assembly worktree with \`fabrika lane assembly ${options.epic}\` before refreshing it.`,
			);
		}
		const path = seat.path;

		const before = yield* headOf(path);
		if (before._tag === "Unreadable") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read the head of ${path}: ${before.reason} — nothing was merged, because there would be nowhere proven to reset back to.`,
			);
		}
		const head = before.sha;

		const seated = yield* trackedChanges(path);
		if (seated._tag === "Unreadable") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read whether ${path} is clean before the merge: ${seated.reason} — whether a conflict would be ${options.base}'s or this tree's is UNKNOWN, so nothing was merged.`,
			);
		}
		if (seated.paths.length > 0) {
			return refuse(
				ASSEMBLY_DIRTY,
				`${VERB}: ${path} already holds ${seated.paths.length} modified tracked path(s) — that dirt is the driver's tree and not ${options.base}'s range, so nothing was fetched or merged and ${path} is still at ${head}. Clean the seat, then refresh again.`,
				seated.paths,
			);
		}

		const fetched = yield* execCapture("git", ["-C", path, "fetch", "--quiet", "origin"]);
		if (!fetched.ok) {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot fetch origin in ${path}: ${fetched.reason} — what ${options.base} points at is UNKNOWN, so nothing was merged and ${path} is still at ${head}.`,
			);
		}

		const resolved = yield* execCapture("git", [
			"-C",
			path,
			"rev-parse",
			"--verify",
			`${options.base}^{commit}`,
		]);
		if (!resolved.ok) {
			return refuse(
				PROOF_ABSENT,
				`${VERB}: origin was fetched and ${options.base} names no commit in ${path}: ${resolved.reason} — name the trunk this run assembles against with --base; nothing was merged.`,
			);
		}
		const tip = resolved.stdout.trim();

		const carried = yield* execCapture("git", [
			"-C",
			path,
			"merge-base",
			"--is-ancestor",
			tip,
			head,
		]);
		if (carried.ok) {
			return answer(`${head}\nREFRESH-VERDICT: CURRENT\n`, [
				`${VERB}: ${branch} at ${path} already carries ${options.base} (${tip}) — nothing was merged.`,
			]);
		}

		const merged = yield* execCapture("git", ["-C", path, "merge", "--no-edit", "--no-ff", tip]);
		if (!merged.ok) {
			// The abort is what releases the conflicted index; `restore` is what proves the branch went
			// back, and it is the one that answers — an abort reporting success over a tree still at the
			// merge is exactly the claim this verb refuses to relay.
			yield* execCapture("git", ["-C", path, "merge", "--abort"]);
			return yield* restore(
				path,
				head,
				refuse(
					MERGE_CONFLICT,
					`${VERB}: ${options.base} (${tip}) conflicts with ${branch}; the merge was aborted. Park the lane on \`--cause ${REFRESH_PARK_CAUSE}\` — resolving a conflict that is not a plain keep-both is a judgment no verb makes.`,
					diagnostics(merged.reason),
				),
			);
		}

		const landed = yield* headOf(path);
		if (landed._tag === "Unreadable") {
			return refuse(
				APPEND_UNKNOWN,
				`${VERB}: the merge passed and ${path}'s head cannot be read back: ${landed.reason} — what the assembly branch now carries is UNKNOWN.`,
			);
		}
		if (landed.sha === head) {
			return refuse(
				APPEND_UNKNOWN,
				`${VERB}: \`git merge\` reported success and ${path} is still at ${head} — whether ${branch} carries ${options.base} is UNKNOWN, never a silent pass.`,
			);
		}
		return answer(`${landed.sha}\nREFRESH-VERDICT: MERGED\n`, [
			`${VERB}: merged ${options.base} (${tip}) into ${branch} at ${path}; nothing was pushed.`,
		]);
	});
