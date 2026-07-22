/**
 * The `merge-intent` tool — `pipeline-cli merge-intent disarm [flags]` (issue #3723, ADR 0198).
 *
 *   pipeline-cli merge-intent disarm --pr 3700 --site refuse
 *   pipeline-cli merge-intent disarm --pr 3700 --site ejected --repo owner/r
 *
 * The enforcement half of ship-it's no-parked-merge-intent invariant: at each lifecycle site
 * where a run could leave a `gh pr merge --auto` request armed, this verb reads the live merge
 * state, applies the pure `decideMergeIntent` branch, and — when the branch says so — clears the
 * request and **verifies the clear by re-reading `auto_merge`**.
 *
 * Prints the outcome word (`kept` / `disarmed` / `failed`) to **stdout** and the deciding reason
 * to **stderr**. Exit is **0 on `kept`/`disarmed`, 1 on `failed`** — so a ship-it stop path reads
 * `pipeline-cli merge-intent disarm … || <surface the failure>` and never reports a clean STOP
 * while an intent is still armed. Failing loud is the whole contract: an unresolvable repo, an
 * unknown site, or a disarm the read-back cannot confirm are all `failed`, because each leaves
 * the invariant unproven.
 */
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {Github, GithubLive} from "./github.ts";
import {decideMergeIntent, type IntentSite} from "./merge-intent.ts";

const SITES: ReadonlyArray<IntentSite> = ["preflight", "refuse", "post-enqueue", "ejected"];

const prFlag = Flag.integer("pr").pipe(
	Flag.withDescription("the PR number whose merge intent is being resolved"),
);

const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription("owner/repo (default: CLAUDE_PIPELINE_REPO / gh repo view)"),
);

const siteFlag = Flag.string("site").pipe(
	Flag.withDescription(`ship-it lifecycle site: ${SITES.join(" | ")}`),
);

const say = (line: string): Effect.Effect<void> =>
	Effect.sync(() => process.stderr.write(`merge-intent: ${line}\n`));

/** Print the loud failure word + reason and exit 1 — the invariant could not be proven. */
const failed = (reason: string): Effect.Effect<void> =>
	say(`FAILED — ${reason}`).pipe(
		Effect.andThen(Console.log("failed")),
		Effect.andThen(Effect.sync(() => process.exit(1))),
	);

const disarmCmd = Command.make(
	"disarm",
	{pr: prFlag, repo: repoFlag, site: siteFlag},
	Effect.fn(function* ({pr, repo, site}) {
		if (!SITES.includes(site as IntentSite)) {
			return yield* failed(`unknown --site '${site}' (expected one of: ${SITES.join(", ")})`);
		}
		const repoOverride = Option.getOrUndefined(repo);
		const github = yield* Github;
		const state = yield* github
			.state(pr, repoOverride)
			.pipe(
				Effect.catchTag("@kampus/merge-intent/RepoResolutionError", (e) =>
					Effect.as(failed(e.message), null),
				),
			);
		if (state === null) return;

		const decision = decideMergeIntent(site as IntentSite, state);
		yield* say(
			`#${pr} site=${site} armed=${state.armed} merged=${state.merged} queued=${state.queued} ever-queued=${state.everQueued} → ${decision.action}: ${decision.reason}`,
		);
		if (decision.action === "keep") {
			return yield* Console.log("kept");
		}

		const outcome = yield* github
			.disarm(pr, repoOverride)
			.pipe(
				Effect.catchTag("@kampus/merge-intent/RepoResolutionError", (e) =>
					Effect.as(failed(e.message), null),
				),
			);
		if (outcome === null) return;
		if (!outcome.cleared) {
			// The disable did not take, or the read-back could not confirm it — either way the PR may
			// still carry an intent that a later approval would fire, so this must not read as success.
			return yield* failed(
				`the merge intent on #${pr} is still armed (or unverifiable) after \`gh pr merge --disable-auto\` (exit ${outcome.exitCode}${outcome.stderr ? `: ${outcome.stderr}` : ""}) — disable it by hand before the PR is approved again`,
			);
		}
		yield* say(
			`#${pr} carries no armed auto-merge request (verified by read-back${outcome.exitCode === 0 ? "" : `; the disable itself exited ${outcome.exitCode}, tolerated`})`,
		);
		yield* Console.log("disarmed");
	}),
).pipe(
	Command.withDescription(
		"Clear a parked `--auto` merge intent at a ship-it lifecycle site, verified by read-back (ADR 0198, #3723)",
	),
);

export const mergeIntentCommand = Command.make("merge-intent").pipe(
	Command.withSubcommands([disarmCmd]),
	Command.withDescription(
		"ship-it's no-parked-merge-intent enforcement — no `--auto` survives a run that did not enqueue (ADR 0198, #3723)",
	),
	Command.provide(GithubLive),
);
