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
 * The IO lives in `github.ts` (the `Github` service — the `gh` REST boundary, ADR-0062 repo
 * resolution, Schema-decoded PR-state + timeline reads); the decision in `merge-queue-classify.ts`
 * (the pure core). This bin is the thin glue: read the ground-truth `MergeQueueSignals` via the
 * service, hand them to `classify`, and print the word.
 *
 * Fail-closed away from a false ship (preserved through the #2738 idiom remediation): an
 * unresolvable repo (`RepoResolutionError`) or an unreadable PR state (`GhCommandError` /
 * `GhParseError` / `SchemaError`) resolves to `pending` (still settling), never `merged` and
 * never `ejected` — the service already recovers an unreadable timeline to the settle window. A
 * classifier miss can only ever keep polling within the bounded window; it can neither report a
 * false success nor trigger a false re-drive.
 */
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {Github, GithubLive} from "./github.ts";
import {classify} from "./merge-queue-classify.ts";

const prFlag = Flag.integer("pr").pipe(
	Flag.withDescription("the PR number to classify the merge-queue state of"),
);

const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription("owner/repo (default: CLAUDE_PIPELINE_REPO / gh repo view)"),
);

/** Emit the fail-closed `pending` verdict: the reason on stderr, the outcome word on stdout. */
const pending = (reason: string): Effect.Effect<void> =>
	Effect.sync(() => process.stderr.write(`merge-queue-classify: ${reason}\n`)).pipe(
		Effect.andThen(Console.log("pending")),
	);

const classifyCmd = Command.make(
	"classify",
	{pr: prFlag, repo: repoFlag},
	Effect.fn(function* ({pr, repo}) {
		// null = a fail-closed branch already printed `pending`; every read fault folds to it, so
		// an unresolvable repo / unreadable PR state can only ever keep the reconcile polling.
		const signals = yield* (yield* Github).signals(pr, Option.getOrUndefined(repo)).pipe(
			Effect.catchTag("@kampus/merge-queue-classify/RepoResolutionError", () =>
				Effect.as(pending("could not resolve repo — pending."), null),
			),
			Effect.catchTags({
				"@kampus/merge-queue-classify/GhCommandError": () =>
					Effect.as(pending("could not read PR state — pending."), null),
				"@kampus/merge-queue-classify/GhParseError": () =>
					Effect.as(pending("could not read PR state — pending."), null),
				SchemaError: () => Effect.as(pending("could not read PR state — pending."), null),
			}),
		);
		if (signals === null) {
			return;
		}
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
	Command.provide(GithubLive),
);
