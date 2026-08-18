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
import {Argument, Command, Flag} from "effect/unstable/cli";
import {leafCommand} from "../excess-operand.ts";
import type {VerbOutcome} from "../verb.ts";
import {runCatalogGuard} from "./catalog-verb.ts";
import {runFanoutGuard} from "./fanout-verb.ts";
import {runHomingGuard} from "./homing-verb.ts";
import {runLeakGuard} from "./leak-verb.ts";
import {runPatchGuard} from "./patch-verb.ts";
import {runPointerGuard} from "./pointer-verb.ts";
import {runPublishIsolationGuard} from "./publish-isolation-verb.ts";
import {runReadmeGuard} from "./readme-verb.ts";
import {runRoadmapGuard} from "./roadmap-verb.ts";
import {runSettingsEnvGuard} from "./settings-env-verb.ts";
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

const settingsEnvCheck = leafCommand(
	"check",
	{root: rootFlag},
	Effect.fn(function* ({root}) {
		yield* emit(
			yield* runSettingsEnvGuard({
				root: Option.getOrNull(root),
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	// biome-ignore-start lint/suspicious/noTemplateCurlyInString: the brace token IS this guard's subject — help text that spelled it any other way would not name the thing a reader is searching for.
	Command.withShortDescription("Red on an unexpanded ${...} in a settings.json env value."),
	Command.withDescription(
		"Red when any `.claude/settings.json` `env` VALUE carries an unexpanded `${...}` token. Claude Code applies env values verbatim and expands nothing in them, so such a token never resolves — it is consumed literally, which is how one created a stray literal-token directory at the repo root and clobbered PATH (#2495). An empty or absent `env` block is a real pass; the fail-closed case is the file. Prints the one-line all-clear on stdout; a red puts the report on stderr, with GitHub ::error annotations beside it under Actions. Exits 7 (zero scope: no .claude/settings.json to scan — fail-closed, ADR 0092), 11 (the file could not be read or does not parse, so the verdict is UNKNOWN), 12 (an env value carries a brace token). Example: fabrika guard settings-env-guard check",
	),
);

const settingsEnvGuard = Command.make("settings-env-guard").pipe(
	Command.withSubcommands([settingsEnvCheck]),
	Command.withShortDescription("No settings.json env value expects an expansion that never runs."),
	Command.withDescription(
		"Claude Code applies `.claude/settings.json` `env` values verbatim — it expands no `${VAR}` in them. An env value written as if it would expand never resolves, so the whole class is banned rather than left to whoever remembers the harness's behaviour.",
	),
	// biome-ignore-end lint/suspicious/noTemplateCurlyInString: back to the ordinary rule.
);

const catalogCheck = leafCommand(
	"check",
	{root: rootFlag},
	Effect.fn(function* ({root}) {
		yield* emit(
			yield* runCatalogGuard({
				root: Option.getOrNull(root),
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Red on a package.json dep pinning a hardcoded version."),
	Command.withDescription(
		"Every dependency in every workspace `package.json` — the root manifest included — must be sourced from the pnpm `catalog:` or a `workspace:` ref, never a hardcoded version string. A second version of one dep breaks frozen-lockfile CI downstream, which is what a hardcoded `@distilled.cloud/cloudflare` did in #535. A genuinely unavoidable exception lives in the guard's explicit reasoned allowlist, never a silent tolerance (#2737). Prints the one-line all-clear on stdout; a red puts the report on stderr, with GitHub ::error annotations on the offending manifest line under Actions. Exits 7 (zero scope: no manifest scanned — fail-closed, ADR 0092), 11 (a manifest could not be read or does not parse, so the verdict is UNKNOWN), 12 (a dep pins a hardcoded version). Example: fabrika guard catalog-guard check",
	),
);

const catalogGuard = Command.make("catalog-guard").pipe(
	Command.withSubcommands([catalogCheck]),
	Command.withShortDescription("Every dependency is on catalog: or workspace:."),
	Command.withDescription(
		"One shared version per dependency across the repo, declared once in `pnpm-workspace.yaml`. The convention was written and unenforced, so it held only by reviewer vigilance until a hardcoded pin broke frozen-lockfile CI.",
	),
);

const fanoutCheck = leafCommand(
	"check",
	{root: rootFlag},
	Effect.fn(function* ({root}) {
		yield* emit(
			yield* runFanoutGuard({
				root: Option.getOrNull(root),
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Red on a fanned mutation that omits its /fate/live publish."),
	Command.withDescription(
		"Three invariants over the worker's `Fate.mutation` set (ADR 0155): every mutation is classified fanned/not in the fanned-mutations manifest, every fanned mutation's feature publishes a `/fate/live` invalidation, and every declared topic is still reachable from that feature's `live.ts` binding. The omission is invisible at the mutation site — the publisher's error channel is `never` — which is why four features shipped it silently (#1893–#1896), and the mis-aim class needed the third invariant on top (#2554). Prints the one-line all-clear on stdout; a red puts the report on stderr, with GitHub ::error annotations beside it under Actions. Exits 7 (zero scope: no mutation discovered, or the manifest parsed to no rows — fail-closed, ADR 0092), 11 (a source could not be read, so the verdict is UNKNOWN), 12 (drift, a missing publish, or a mis-aimed topic). Example: fabrika guard fanout-guard check",
	),
);

const fanoutGuard = Command.make("fanout-guard").pipe(
	Command.withSubcommands([fanoutCheck]),
	Command.withShortDescription("Every fanned mutation publishes its /fate/live invalidation."),
	Command.withDescription(
		"A mutation that writes an entity in a subscribed connection must publish the `/fate/live` invalidation after the write, or every other client's live view goes stale. Nothing at the call site forces it, so the classification is a manifest and this guard is what reads it (ADR 0155).",
	),
);

const patchCheck = leafCommand(
	"check",
	{root: rootFlag},
	Effect.fn(function* ({root}) {
		yield* emit(
			yield* runPatchGuard({
				root: Option.getOrNull(root),
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Red on a pnpm patch with no behavior-pinning test."),
	Command.withDescription(
		"Every maintained `pnpm patch` must carry at least one registered behavior-pinning test, and no pin may be stale. A patch is a silent fork of a dependency's behaviour, so ADR 0038 requires a test that fails if the patched behaviour regresses; that test self-registers with a `// @patch-pin: <name>@<version>` marker keyed to the exact `patchedDependencies` entry (`.patterns/dependency-patch-behavior-pins.md`). Prints the one-line all-clear on stdout; a red puts the report on stderr, with GitHub ::error annotations beside it under Actions. Exits 7 (zero scope: no patchedDependencies in scope — fail-closed, ADR 0092), 11 (a read failed, so the verdict is UNKNOWN), 12 (an unpinned patch or a stale pin). Example: fabrika guard patch-guard check",
	),
);

const patchGuard = Command.make("patch-guard").pipe(
	Command.withSubcommands([patchCheck]),
	Command.withShortDescription("Every maintained pnpm patch is pinned by a behavior test."),
	Command.withDescription(
		"A `pnpm patch` forks a dependency's behaviour silently. ADR 0038's forcing function is this guard: a patch whose behaviour no test pins is a fork nothing verifies, and a pin left behind after the patch moved is a test guarding nothing.",
	),
);

const pointerCheck = leafCommand(
	"check",
	{root: rootFlag},
	Effect.fn(function* ({root}) {
		yield* emit(
			yield* runPointerGuard({
				root: Option.getOrNull(root),
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Red on a backticked CLAUDE.md path that no longer resolves."),
	Command.withDescription(
		"Every backticked repo-root-relative path in a git-tracked `CLAUDE.md` must resolve on disk, or be gitignored — a deliberately-absent generated path like `apps/web/.env` is a valid pointer, not rot. This is the class the `doc-links` gate cannot see: it validates `[text](path)` links and masks code spans by construction, so a backticked prose pointer rots unseen when its target moves (#988). Only unambiguous root-relative tokens are read, so a bare basename or an app-relative fragment is left alone. Prints the one-line all-clear on stdout; a red puts the file:line → path report on stderr, with GitHub ::error annotations on the pointer's line under Actions. Exits 7 (zero scope: no tracked CLAUDE.md — fail-closed, ADR 0092), 11 (git could not list the docs, or one could not be read, so the verdict is UNKNOWN), 12 (a pointer does not resolve). Example: fabrika guard pointer-guard check",
	),
);

const pointerGuard = Command.make("pointer-guard").pipe(
	Command.withSubcommands([pointerCheck]),
	Command.withShortDescription("Backticked CLAUDE.md path pointers still resolve."),
	Command.withDescription(
		"CLAUDE.md routes every agent by backticked prose pointers, and the link gate masks exactly those spans. A pointer whose target has been renamed sends every reader to a path that is not there — the same silent-drift class as the dead README and the dead guard path.",
	),
);

const publishIsolationCheck = leafCommand(
	"check",
	{root: rootFlag},
	Effect.fn(function* ({root}) {
		yield* emit(
			yield* runPublishIsolationGuard({
				root: Option.getOrNull(root),
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Red on a published package linking a private or workspace dep."),
	Command.withDescription(
		"Every package the release pipeline ships must be installable from a clean registry state: no `workspace:*` specifier and no `@kampus/*` dependency that is not itself published (ADR 0201 §3). The published set is DERIVED from `publish.yml`'s release-tag grammar rather than hand-kept, so it cannot drift from what actually publishes. The forcing incident: `pipeline-cli@0.2.0` published green and was uninstallable, because it declared three phoenix-private packages as registry deps (#3802). Prints the one-line all-clear on stdout; a red puts the report on stderr, with GitHub ::error annotations on the offending manifest under Actions. Exits 7 (zero scope: no published package derived, or a tag prefix maps to no member — fail-closed, ADR 0092), 11 (a manifest could not be read or does not parse, so the verdict is UNKNOWN), 12 (a published package links a private or workspace dep). Example: fabrika guard publish-isolation-guard check",
	),
);

const publishIsolationGuard = Command.make("publish-isolation-guard").pipe(
	Command.withSubcommands([publishIsolationCheck]),
	Command.withShortDescription("Every published package installs from a clean registry."),
	Command.withDescription(
		"A published artifact may depend only on what a clean registry can resolve. Publishing is green whatever the dependency graph says, so the failure lands on whoever installs the package rather than on the release — which is why it is a gate rather than a review item (ADR 0201 §3).",
	),
);

/**
 * The one leaf in this group that is not `check`: its scope is the CHANGE, so the caller resolves
 * the diff and hands the file list in. `atLeast(0)` rather than `atLeast(1)` on purpose — a
 * zero-file invocation must reach the verb and red there (ADR 0092), not bounce off the parser's
 * arity error, which a caller could read as a usage problem rather than as a broken scope.
 */
const leakScan = leafCommand(
	"scan",
	{
		files: Argument.string("file").pipe(
			Argument.atLeast(0),
			Argument.withDescription("the changed files to scan for machine-local paths"),
		),
	},
	Effect.fn(function* ({files}) {
		yield* emit(yield* runLeakGuard({files, cwd: process.cwd(), env: process.env}));
	}),
).pipe(
	Command.withShortDescription("Red on a machine-local path in a changed doc or shell file."),
	Command.withDescription(
		"Scan the handed files for machine-local filesystem paths in shared-artifact surfaces — markdown and `.decisions/`/`.patterns/` docs, and `.sh` scripts, which a whole-file scan covers because a shell comment is the likeliest place for one to land (#173, #4496). The scanner self-scopes, so a caller may hand it every changed file. Prints the one-line all-clear with its per-surface scope on stdout; a red puts the report on stderr, with GitHub ::error annotations on each file under Actions. Exits 7 (zero scope: an empty file list — fail-closed, ADR 0092), 11 (a handed file exists and could not be read, so the verdict is UNKNOWN), 12 (a machine-local path is in a scanned surface). Example: fabrika guard leak-guard scan docs/guide.md scripts/run.sh",
	),
);

const leakGuard = Command.make("leak-guard").pipe(
	Command.withSubcommands([leakScan]),
	Command.withShortDescription("No machine-local path reaches a shared artifact."),
	Command.withDescription(
		"CI is the only surface that sees every change's diff whatever wrote it, so it — not a write-time hook — is the unbypassable gate for the no-machine-local-paths rule.",
	),
);

/** The registered guards. One appended row per port; the order is the `--help` order. */
const guards = [
	readmeGuard,
	skillLint,
	homingGuard,
	roadmapGuard,
	unresolvedThreadsGuard,
	settingsEnvGuard,
	catalogGuard,
	fanoutGuard,
	patchGuard,
	pointerGuard,
	publishIsolationGuard,
	leakGuard,
];

export const guardCommand = Command.make("guard").pipe(
	Command.withSubcommands(guards),
	Command.withShortDescription("Run one of the repo's fail-closed CI gates."),
	Command.withDescription(
		"Run one of the repo's fail-closed CI gates: `fabrika guard <name> check`. Every guard scopes itself from the workspace or the change, reds on a violation, and reds on zero scope rather than passing vacuously (ADR 0092)",
	),
);
