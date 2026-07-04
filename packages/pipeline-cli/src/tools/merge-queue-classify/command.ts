/**
 * The `merge-queue-classify` tool — `pipeline-cli merge-queue-classify classify [flags]`.
 *
 *   pipeline-cli merge-queue-classify classify --pr 1906
 *   pipeline-cli merge-queue-classify classify --pr 1906 --repo owner/r
 *
 * The classifier for ship-it Step 5.5's bounded post-enqueue reconcile (issue #1921).
 * Prints the outcome word (`merged` / `ejected` / `queued` / `pending`) to **stdout** and
 * the deciding reason to **stderr**, exiting 0 on any completed classification — the
 * outcome is the value, read it from stdout. Step 5.5 shells out to this per poll and
 * branches on the printed word.
 *
 * The IO lives here (the thin bin), the decision in `merge-queue-classify.ts` (the pure
 * core). This bin reads the two authoritative ground-truth signals via `gh`:
 *   - PR `state` + `mergeStateStatus` from `gh pr view --json` (the same sanctioned
 *     PR-state read ship-it Step 2 uses — NOT a GraphQL intake query the org's
 *     Projects-classic integration breaks).
 *   - the LAST merge-queue timeline event (`added_to_merge_queue` /
 *     `removed_from_merge_queue`) from `gh api repos/<repo>/issues/<pr>/timeline` (REST,
 *     never GraphQL) — the authoritative queue-membership signal (GitHub "Managing a
 *     merge queue"), verified live on PR #1906.
 *
 * Fail-closed away from a false ship: an unreadable PR state, an unreadable timeline, or
 * any ambiguity resolves to `pending` (still settling), never `merged` and never
 * `ejected` — a classifier miss can only ever keep polling within the bounded window, it
 * can neither report a false success nor trigger a false re-drive.
 */
import {execFileSync} from "node:child_process";
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {classify, lastMergeQueueEvent, type MergeQueueSignals} from "./merge-queue-classify.ts";

const prFlag = Flag.integer("pr").pipe(
	Flag.withDescription("the PR number to classify the merge-queue state of"),
);

const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription("owner/repo (default: CLAUDE_PIPELINE_REPO / gh repo view)"),
);

/** Resolve owner/repo: `--repo`, else `CLAUDE_PIPELINE_REPO`, else `gh repo view`. null on failure. */
const resolveRepo = (repo: Option.Option<string>): string | null => {
	const explicit = Option.getOrUndefined(repo) ?? process.env.CLAUDE_PIPELINE_REPO;
	if (explicit !== undefined && explicit.trim() !== "") return explicit.trim();
	try {
		return execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
			encoding: "utf8",
		}).trim();
	} catch {
		return null;
	}
};

/** The PR state read from `gh pr view` — merged/state/mergeStateStatus. null on any read failure. */
interface PrState {
	readonly merged: boolean;
	readonly state: string;
	readonly mergeStateStatus: string | undefined;
}

/**
 * Read the PR's `state` + `mergeStateStatus` via `gh pr view --json` — the working fields
 * (the old `merged` JSON field errors `Unknown JSON field` on this gh/repo, #1921); the
 * `merged` signal is derived from `state == MERGED`. Returns null on any read failure.
 */
const readPrState = (repo: string, pr: number): PrState | null => {
	try {
		const raw = execFileSync(
			"gh",
			[
				"pr",
				"view",
				String(pr),
				"--repo",
				repo,
				"--json",
				"state,mergeStateStatus",
				"--jq",
				"{state: .state, mergeStateStatus: .mergeStateStatus}",
			],
			{encoding: "utf8"},
		);
		const parsed = JSON.parse(raw) as {state?: unknown; mergeStateStatus?: unknown};
		const state = typeof parsed.state === "string" ? parsed.state : "";
		return {
			merged: state === "MERGED",
			state,
			mergeStateStatus:
				typeof parsed.mergeStateStatus === "string" ? parsed.mergeStateStatus : undefined,
		};
	} catch {
		return null;
	}
};

/**
 * Read the LAST merge-queue timeline event via the REST issue-timeline endpoint (never
 * GraphQL). Returns `null` on any read failure — the core then treats a missing event as
 * the settle window (`pending`), the fail-closed-away-from-a-false-ship posture.
 */
const readLastMergeQueueEvent = (
	repo: string,
	pr: number,
): "added_to_merge_queue" | "removed_from_merge_queue" | null => {
	try {
		const raw = execFileSync(
			"gh",
			["api", `repos/${repo}/issues/${pr}/timeline?per_page=100`, "--paginate"],
			{encoding: "utf8"},
		);
		// `--paginate` concatenates JSON arrays; normalize `][` joins into one array.
		const merged = raw.replace(/\]\s*\[/g, ",");
		const timeline = JSON.parse(merged) as ReadonlyArray<{event?: string; created_at?: string}>;
		return lastMergeQueueEvent(timeline);
	} catch {
		return null;
	}
};

const classifyCmd = Command.make(
	"classify",
	{pr: prFlag, repo: repoFlag},
	Effect.fn(function* ({pr, repo}) {
		const resolvedRepo = resolveRepo(repo);
		if (resolvedRepo === null) {
			// No repo ⇒ cannot read ground truth ⇒ still settling (keep polling), never a false verdict.
			yield* Effect.sync(() =>
				process.stderr.write("merge-queue-classify: could not resolve repo — pending.\n"),
			);
			yield* Console.log("pending");
			return;
		}
		const prState = readPrState(resolvedRepo, pr);
		if (prState === null) {
			yield* Effect.sync(() =>
				process.stderr.write("merge-queue-classify: could not read PR state — pending.\n"),
			);
			yield* Console.log("pending");
			return;
		}
		const lastEvent = readLastMergeQueueEvent(resolvedRepo, pr);
		const signals: MergeQueueSignals = {
			merged: prState.merged,
			state: prState.state,
			lastMergeQueueEvent: lastEvent,
			mergeStateStatus: prState.mergeStateStatus,
		};
		const result = classify(signals);
		yield* Effect.sync(() => process.stderr.write(`merge-queue-classify: ${result.reason}\n`));
		yield* Console.log(result.outcome);
	}),
).pipe(
	Command.withDescription(
		"Classify a PR's post-enqueue merge-queue state (merged/ejected/queued/pending; #1921)",
	),
);

export const mergeQueueClassifyCommand = Command.make("merge-queue-classify").pipe(
	Command.withSubcommands([classifyCmd]),
	Command.withDescription(
		"Authoritative merge-queue-state classifier for ship-it Step 5.5's reconcile (#1921)",
	),
);
