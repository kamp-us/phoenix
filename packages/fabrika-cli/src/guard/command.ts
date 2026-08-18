/**
 * The `guard` verb group — `fabrika guard <name> check`, the CI gates that used to live in
 * `pipeline-cli` (epic #5720).
 *
 * Unlike every other group here, this one nests: a guard is its own subcommand and `check` is its
 * leaf, so CI reads `node packages/fabrika-cli/src/bin.ts guard readme-guard check` — the shape
 * `governance-floor.yml` already uses, with the guard's name where a reader expects it. Each ported
 * guard appends one row to {@link guards} and one `<name>-verb.ts` beside this file; nothing else
 * about the group changes, which is what keeps five batches of ports off each other's lines.
 *
 * The adapter and nothing else: it declares the flags, reads the two machine facts the verbs do not
 * derive — the working directory and the environment — runs the pure verb, and emits its outcome.
 */

import {Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {leafCommand} from "../excess-operand.ts";
import type {VerbOutcome} from "../verb.ts";
import {runHomingGuard} from "./homing-verb.ts";
import {runReadmeGuard} from "./readme-verb.ts";
import {runRoadmapGuard} from "./roadmap-verb.ts";
import {runSkillLint} from "./skill-lint-verb.ts";
import {runUnresolvedThreadsGuard} from "./unresolved-threads-verb.ts";

/** Write the outcome and exit on its code — stdout is the answer, everything else is stderr. */
const emit = (outcome: VerbOutcome): Effect.Effect<void> =>
	Effect.sync(() => {
		for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
		if (outcome.stdout !== "") process.stdout.write(outcome.stdout);
		process.exit(outcome.code);
	});

const rootFlag = Flag.string("root").pipe(
	Flag.optional,
	Flag.withDescription("the repo root to scan (default: walk up from the cwd for one)"),
);

/** The board guards read GitHub, so each takes the same target-repo flag every other group uses. */
const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription(
		"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
	),
);

const readmeCheck = leafCommand(
	"check",
	{root: rootFlag},
	Effect.fn(function* ({root}) {
		yield* emit(
			yield* runReadmeGuard({
				root: Option.getOrNull(root),
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Red unless every packages/* member carries a README.md."),
	Command.withDescription(
		"Fail the build unless every real packages/* workspace member (a directory carrying a package.json) holds a README.md. Dead-shell directories are ignored. Prints the one-line all-clear on stdout; a red puts the report on stderr, with GitHub ::error annotations beside it under Actions. Exits 7 (zero scope: no member scanned, or pnpm-workspace.yaml no longer declares packages/* — fail-closed, ADR 0092), 11 (a read failed, so the verdict is UNKNOWN), 12 (a member has no README.md). Example: fabrika guard readme-guard check",
	),
);

const readmeGuard = Command.make("readme-guard").pipe(
	Command.withSubcommands([readmeCheck]),
	Command.withShortDescription("Every packages/* workspace package carries a README.md."),
	Command.withDescription(
		"Every packages/* workspace package must carry a README.md — what it is, why it exists, how to use it. A package with no README has no entry point for a reader or a consumer.",
	),
);

const skillLintCheck = leafCommand(
	"check",
	{root: rootFlag},
	Effect.fn(function* ({root}) {
		yield* emit(
			yield* runSkillLint({
				root: Option.getOrNull(root),
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Red on a broken gh call, frontmatter, push or path in a skill."),
	Command.withDescription(
		"Walk claude-plugins/ and red on any of four mechanical defects in the skill + agent corpus: a GraphQL-path `gh` invocation (REST only on this org, #743), a SKILL.md / agents/*.md frontmatter block that does not parse as strict YAML (#1766), a bare `git push` in a runnable block (#4213), and a repo-relative `./claude-plugins/…` literal inside a fence, which cannot resolve in a consumer's install (#4605). Prose naming a forbidden form is untouched; only runnable text is judged. Prints the one-line all-clear on stdout; a red puts the report on stderr, with GitHub ::error annotations beside it under Actions. Exits 7 (zero scope: nothing walked, a plugin dir contributed no file, or a check saw no file — fail-closed, ADR 0092), 11 (a read failed, so the verdict is UNKNOWN), 12 (a defect was found). Example: fabrika guard skill-lint check",
	),
);

const skillLint = Command.make("skill-lint").pipe(
	Command.withSubcommands([skillLintCheck]),
	Command.withShortDescription("The skill + agent corpus obeys its four mechanical rules."),
	Command.withDescription(
		"The skill and agent corpus under claude-plugins/ must hold no GraphQL-path `gh` call, no unparseable frontmatter, no bare `git push` in a runnable block, and no plugin path literal that only resolves inside this repo.",
	),
);

const homingCheck = leafCommand(
	"check",
	{
		issue: Flag.integer("issue").pipe(
			Flag.optional,
			Flag.withDescription("check one issue (default: the whole open status:triaged backlog)"),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({issue, repo}) {
		yield* emit(
			yield* runHomingGuard({
				issue: Option.getOrNull(issue),
				repo: Option.getOrNull(repo),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Red unless every triaged issue is homed or standing-lane exempt."),
	Command.withDescription(
		"Every `status:triaged` issue must carry EITHER an arc/campaign milestone OR exactly one of the two standing-lane labels (`wayfinder:backlog`, `axis:pipeline-hardening`) — never neither, and never both, which ADR 0208 bans outright. `--issue N` scopes the scan to the one issue triage just stamped, which is the seam the invariant binds at; a bare run sweeps the whole open triaged backlog. Prints the one-line all-clear on stdout; a red puts the per-class remedy on stderr, with GitHub ::error annotations beside it under Actions. Exits 7 (zero scope: the backlog sweep found no triaged issue at all — fail-closed, ADR 0092), 11 (the board, the label set or the issue could not be read, so the verdict is UNKNOWN), 12 (an issue has no home, or claims two). Example: fabrika guard homing-guard check --issue 4312",
	),
);

const homingGuard = Command.make("homing-guard").pipe(
	Command.withSubcommands([homingCheck]),
	Command.withShortDescription("Every triaged issue leaves triage with exactly one home."),
	Command.withDescription(
		"Every issue that leaves triage carries exactly one home: an arc/campaign milestone, or one of exactly two standing-lane labels. A standing lane is milestone-less by design, so the two marks cannot both be true (ADR 0202 forward-motion doctrine, ADR 0208 standing-lane exemption).",
	),
);

const roadmapCheck = leafCommand(
	"check",
	{root: rootFlag, repo: repoFlag},
	Effect.fn(function* ({root, repo}) {
		yield* emit(
			yield* runRoadmapGuard({
				root: Option.getOrNull(root),
				repo: Option.getOrNull(repo),
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Red on ROADMAP.md ↔ GitHub-milestone drift."),
	Command.withDescription(
		"Validate ROADMAP.md's founder-voice `## Arcs`/`## Campaigns` tables against the live GitHub milestone projection. ROADMAP.md is the sole parsed surface; the invariants are I1 every arc/campaign pinned to an existing milestone by number (a queued arc may defer), I2 exactly one active arc, I3 no unclaimed open milestone, I4 fail-closed on zero scope (ADR 0092), I5 active↔done state symmetry (an active row's milestone open, a done row's closed), I6 exactly one focus row naming a campaign the table declares. Prints the one-line all-clear with its scanned counts on stdout; a red names every drifted row on stderr, with GitHub ::error annotations on ROADMAP.md under Actions. Exits 7 (zero scope: no row parsed or no milestone read), 11 (ROADMAP.md or the projection could not be read, so the verdict is UNKNOWN), 12 (drift). Example: fabrika guard roadmap-guard check",
	),
);

const roadmapGuard = Command.make("roadmap-guard").pipe(
	Command.withSubcommands([roadmapCheck]),
	Command.withShortDescription("ROADMAP.md and the milestone projection stay in sync."),
	Command.withDescription(
		"ROADMAP.md's founder-voice arc/campaign tables and the GitHub milestone projection they pin to must stay in sync. Sync-drift diligence is load-bearing — the focus fence every claim is judged against reads the same rows — so it is guarded fail-closed rather than left to vigilance.",
	),
);

const unresolvedThreadsCheck = leafCommand(
	"check",
	{
		pr: Flag.integer("pr").pipe(
			Flag.withDescription("the pull request whose review threads to account for"),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({pr, repo}) {
		yield* emit(
			yield* runUnresolvedThreadsGuard({pr, repo: Option.getOrNull(repo), env: process.env}),
		);
	}),
).pipe(
	Command.withShortDescription("Red on an unresolved review thread the verdict never named."),
	Command.withDescription(
		"Red when a live-unresolved inline review thread — human or CodeQL/GHAS bot — is unaccounted-for in the latest authorized `review-code` verdict, which accounts for a thread by naming its `path:line`. Polarity-blind: a FAIL row naming the site accounts for it exactly as a PASS does, so what this catches is the silent omission, not the objection. Zero threads is a clean, proven pass — the fail-closed case is a thread channel that could not be READ. Exits 11 (the threads, the comments or an author's permission could not be read, so the verdict is UNKNOWN, never clean), 12 (a live thread is unaccounted-for). See ADR 0158. Example: fabrika guard unresolved-threads-guard check --pr 4321",
	),
);

const unresolvedThreadsGuard = Command.make("unresolved-threads-guard").pipe(
	Command.withSubcommands([unresolvedThreadsCheck]),
	Command.withShortDescription("No unaccounted unresolved review thread reaches merge-ready."),
	Command.withDescription(
		"An unresolved inline review thread is a merge gate (ADR 0158), and a review verdict that simply omits one used to be the only thing standing between a CodeQL finding and a human merger. This guard is the machine half: every live thread must be named in the verdict, or the check reds.",
	),
);

/** The registered guards. One appended row per port; the order is the `--help` order. */
const guards = [readmeGuard, skillLint, homingGuard, roadmapGuard, unresolvedThreadsGuard];

export const guardCommand = Command.make("guard").pipe(
	Command.withSubcommands(guards),
	Command.withShortDescription("Run one of the repo's fail-closed CI gates."),
	Command.withDescription(
		"Run one of the repo's fail-closed CI gates: `fabrika guard <name> check`. Every guard scopes itself from the workspace or the change, reds on a violation, and reds on zero scope rather than passing vacuously (ADR 0092)",
	),
);
