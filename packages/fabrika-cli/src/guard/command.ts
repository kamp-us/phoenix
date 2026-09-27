/**
 * The `guard` verb group — `fabrika guard <name> check`, this repository's fail-closed CI gates.
 *
 * Unlike every other group here, this one nests: a guard is its own subcommand and `check` is its
 * leaf, so CI reads `node packages/fabrika-cli/src/bin.ts guard readme-guard check` — the shape
 * `governance-floor.yml` already uses, with the guard's name where a reader expects it. Each ported
 * guard appends one row to {@link registry} and one `<name>-verb.ts` beside this file; nothing else
 * about the group changes, which is what keeps five batches of ports off each other's lines.
 *
 * A row carries the guard's command **and its local-tree membership** — whether `build check` runs
 * it over the checked-out tree, and under which leaf. See `local-tree.ts`.
 *
 * The adapter and nothing else: it declares the flags, reads the two machine facts the verbs do not
 * derive — the working directory and the environment — runs the pure verb, and emits its outcome.
 */

import {Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {runCatalogGuard} from "./catalog-verb.ts";
import {runChangeDetectGuard} from "./change-detect-verb.ts";
import {runCodeownersCpGuard} from "./codeowners-cp-verb.ts";
import {runDecisionsIndexGuard} from "./decisions-number-verb.ts";
import {runDesignInventoryCheck, runDesignInventoryGenerate} from "./design-inventory-verb.ts";
import {runDesignTokenGuard} from "./design-token-verb.ts";
import {runFanoutGuard} from "./fanout-verb.ts";
import {runHomingGuard} from "./homing-verb.ts";
import {runI18nGuard} from "./i18n-literal-verb.ts";
import {runLeakGuard} from "./leak-verb.ts";
import {type LocalTreeGuard, localTree, membersOf, notLocalTree} from "./local-tree.ts";
import {runNoGh} from "./no-gh-verb.ts";
import {runPatchGuard} from "./patch-verb.ts";
import {runPathFilterGuard} from "./path-filter-verb.ts";
import {runPitchGuard} from "./pitch-verb.ts";
import {runPointerGuard} from "./pointer-verb.ts";
import {runPortabilityGuard} from "./portability-verb.ts";
import {runPublishIsolationGuard} from "./publish-isolation-verb.ts";
import {runReadmeGuard} from "./readme-verb.ts";
import {runRoadmapGuard} from "./roadmap-verb.ts";
import {runSettingsEnvGuard} from "./settings-env-verb.ts";
import {runSkillLint} from "./skill-lint-verb.ts";
import {runUnresolvedThreadsGuard} from "./unresolved-threads-verb.ts";

/** A leaf's help in the leaf help rule's shape, ending on the pointer to its contract section. */
const leafHelp = (verb: string, lines: ReadonlyArray<string>): string =>
	[...lines, `  Derivation: the fabrika plugin's docs/guard-contract.md, "${verb}"`].join("\n");

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
				scope: {_tag: "WholeTree"},
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Red unless every packages/* member carries a README.md."),
	Command.withDescription(
		leafHelp("readme-guard check", [
			"Prints a one-line all-clear when every packages/* workspace member holds a README.md.",
			"  A red puts the report on stderr, with GitHub ::error annotations under Actions.",
			"  7: zero scope: no member, or packages/* no longer declared",
			"  11: a read failed, so the verdict is UNKNOWN",
			"  12: a member has no README.md",
		]),
	),
	Command.withExamples([{command: "fabrika guard readme-guard check"}]),
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
		leafHelp("skill-lint check", [
			"Prints a one-line all-clear when the claude-plugins/ skill corpus holds none of four defects.",
			"  A red puts the report on stderr, with GitHub ::error annotations under Actions.",
			"  7: zero scope: nothing walked, or a plugin dir or a check saw no file",
			"  11: a read failed, so the verdict is UNKNOWN",
			"  12: a defect was found",
		]),
	),
	Command.withExamples([{command: "fabrika guard skill-lint check"}]),
);

const skillLint = Command.make("skill-lint").pipe(
	Command.withSubcommands([skillLintCheck]),
	Command.withShortDescription("The skill + agent corpus obeys its four mechanical rules."),
	Command.withDescription(
		"The skill and agent corpus under claude-plugins/ must hold no GraphQL-path `gh` call, no unparseable frontmatter, no bare `git push` in a runnable block, and no plugin path literal that only resolves inside this repo.",
	),
);

const noGhCheck = leafCommand(
	"check",
	{root: rootFlag},
	Effect.fn(function* ({root}) {
		yield* emit(
			yield* runNoGh({
				root: Option.getOrNull(root),
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Red on a `gh` invocation left in fabrika-cli's source."),
	Command.withDescription(
		leafHelp("no-gh check", [
			"Prints a one-line all-clear when packages/fabrika-cli/src/ invokes no `gh` binary.",
			"  A red puts the report on stderr, with GitHub ::error annotations under Actions.",
			"  7: zero scope: nothing walked, or a directory contributed no file",
			"  11: a read failed, so the verdict is UNKNOWN",
			"  12: an invocation was found",
		]),
	),
	Command.withExamples([{command: "fabrika guard no-gh check"}]),
);

const noGhGuard = Command.make("no-gh").pipe(
	Command.withSubcommands([noGhCheck]),
	Command.withShortDescription("fabrika-cli's source holds no `gh` invocation."),
	Command.withDescription(
		"packages/fabrika-cli/src/ must reach GitHub over HTTP and never through the `gh` binary, so that every verb runs from a token alone.",
	),
);

const portabilityCheck = leafCommand(
	"check",
	{root: rootFlag},
	Effect.fn(function* ({root}) {
		yield* emit(
			yield* runPortabilityGuard({
				root: Option.getOrNull(root),
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Red on a reference in fabrika's text that only resolves here."),
	Command.withDescription(
		leafHelp("portability-guard check", [
			"Prints a one-line all-clear when fabrika's shipped text holds no reference only its home resolves.",
			"  A red puts the report on stderr, with GitHub ::error annotations under Actions.",
			"  7: zero scope: an empty walk, or an unusable allow-list",
			"  11: a read failed, so the verdict is UNKNOWN",
			"  12: a reference found, or an allow-list ceiling or floor out of line",
		]),
	),
	Command.withExamples([{command: "fabrika guard portability-guard check"}]),
);

const portabilityGuard = Command.make("portability-guard").pipe(
	Command.withSubcommands([portabilityCheck]),
	Command.withShortDescription("fabrika's shipped text carries no reference to one repository."),
	Command.withDescription(
		"claude-plugins/fabrika/ and packages/fabrika-cli/src/ install into repositories that are not this one, so every rationale in them must read without a link only this repository can resolve.",
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
		leafHelp("homing-guard check", [
			"Prints a one-line all-clear when every status:triaged issue carries exactly one home.",
			"  A home is an arc/campaign milestone or one standing-lane label, never both.",
			"  A red puts the per-class remedy on stderr, with ::error annotations under Actions.",
			"  7: zero scope: the backlog sweep found no triaged issue",
			"  11: the board, the label set or the issue was unreadable (UNKNOWN)",
			"  12: an issue has no home, or claims two",
		]),
	),
	Command.withExamples([{command: "fabrika guard homing-guard check --issue 4312"}]),
);

const homingGuard = Command.make("homing-guard").pipe(
	Command.withSubcommands([homingCheck]),
	Command.withShortDescription("Every triaged issue leaves triage with exactly one home."),
	Command.withDescription(
		"Every issue that leaves triage carries exactly one home: an arc/campaign milestone, or one of exactly two standing-lane labels. A standing lane is milestone-less by design, so the two marks cannot both be true.",
	),
);

const pitchCheck = leafCommand(
	"check",
	{
		issue: Flag.integer("issue").pipe(
			Flag.optional,
			Flag.withDescription(
				"check one issue (default: the whole open lane-entering status:triaged backlog)",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({issue, repo}) {
		yield* emit(
			yield* runPitchGuard({
				issue: Option.getOrNull(issue),
				repo: Option.getOrNull(repo),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Red unless every pickable bet carries a founder-approved pitch."),
	Command.withDescription(
		leafHelp("pitch-guard check", [
			"Prints a one-line all-clear when every lane-entering issue carries a founder-approved pitch.",
			"  Binds at intake only; it is never wired to red a pull request.",
			"  A red puts the per-issue remedy on stderr, with ::error annotations under Actions.",
			"  7: zero scope: the backlog sweep found no lane-entering issue",
			"  11: the board, the label set, an issue or its comments was unreadable (UNKNOWN)",
			"  12: a pickable bet carries no founder-approved pitch",
		]),
	),
	Command.withExamples([{command: "fabrika guard pitch-guard check --issue 4312"}]),
);

const pitchGuard = Command.make("pitch-guard").pipe(
	Command.withSubcommands([pitchCheck]),
	Command.withShortDescription("Lane-entering work becomes pickable only with an approved pitch."),
	Command.withDescription(
		"Direction binds at intake: an epic or a standalone feature only becomes pickable carrying a five-field pitch the founder approved. The pitch is drafted by triage and approved by the founder — never by an agent.",
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
		leafHelp("roadmap-guard check", [
			"Prints a one-line all-clear with counts when ROADMAP.md agrees with the GitHub milestones.",
			"  A red names every drifted row on stderr, with ::error annotations under Actions.",
			"  7: zero scope: no row parsed or no milestone read",
			"  11: ROADMAP.md or the milestones could not be read (UNKNOWN)",
			"  12: drift",
		]),
	),
	Command.withExamples([{command: "fabrika guard roadmap-guard check"}]),
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
		leafHelp("unresolved-threads-guard check", [
			"Prints a one-line all-clear when the review-code verdict names every live unresolved thread.",
			"  Zero threads is a clean pass.",
			"  A red puts the report on stderr, with GitHub ::error annotations under Actions.",
			"  7: zero scope: the pull request was not found",
			"  11: the threads, comments or an author's permission was unreadable (UNKNOWN)",
			"  12: a live thread is unaccounted-for",
		]),
	),
	Command.withExamples([{command: "fabrika guard unresolved-threads-guard check --pr 4321"}]),
);

const unresolvedThreadsGuard = Command.make("unresolved-threads-guard").pipe(
	Command.withSubcommands([unresolvedThreadsCheck]),
	Command.withShortDescription("No unaccounted unresolved review thread reaches merge-ready."),
	Command.withDescription(
		"An unresolved inline review thread is a merge gate. This guard is the machine half: every live thread must be named in the verdict, or the check reds.",
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
		leafHelp("settings-env-guard check", [
			"Prints a one-line all-clear when no .claude/settings.json env value holds a ${...} token.",
			"  A red puts the report on stderr, with GitHub ::error annotations under Actions.",
			"  7: zero scope: no .claude/settings.json to scan",
			"  11: the file could not be read or does not parse (UNKNOWN)",
			"  12: an env value carries a brace token",
		]),
	),
	Command.withExamples([{command: "fabrika guard settings-env-guard check"}]),
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
		leafHelp("catalog-guard check", [
			"Prints a one-line all-clear when every package.json dependency is a catalog: or workspace: ref.",
			"  A red puts the report on stderr, with GitHub ::error annotations under Actions.",
			"  7: zero scope: no manifest scanned",
			"  11: a manifest could not be read or does not parse (UNKNOWN)",
			"  12: a dependency pins a hardcoded version",
		]),
	),
	Command.withExamples([{command: "fabrika guard catalog-guard check"}]),
);

const catalogGuard = Command.make("catalog-guard").pipe(
	Command.withSubcommands([catalogCheck]),
	Command.withShortDescription("Every dependency is on catalog: or workspace:."),
	Command.withDescription(
		"One shared version per dependency across the repo, declared once in `pnpm-workspace.yaml`. A hardcoded pin reads as ordinary in review and breaks frozen-lockfile CI downstream, so the rule is guarded rather than left to vigilance.",
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
		leafHelp("fanout-guard check", [
			"Prints a one-line all-clear when every fanned mutation publishes its /fate/live invalidation.",
			"  A red puts the report on stderr, with GitHub ::error annotations under Actions.",
			"  7: zero scope: no mutation discovered, or the manifest has no rows",
			"  11: a read failed, so the verdict is UNKNOWN",
			"  12: drift, a missing publish, or a mis-aimed topic",
		]),
	),
	Command.withExamples([{command: "fabrika guard fanout-guard check"}]),
);

const fanoutGuard = Command.make("fanout-guard").pipe(
	Command.withSubcommands([fanoutCheck]),
	Command.withShortDescription("Every fanned mutation publishes its /fate/live invalidation."),
	Command.withDescription(
		"A mutation that writes an entity in a subscribed connection must publish the `/fate/live` invalidation after the write, or every other client's live view goes stale. Nothing at the call site forces it, so the classification is a manifest and this guard is what reads it.",
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
		leafHelp("patch-guard check", [
			"Prints a one-line all-clear when every pnpm patch has a registered behavior-pinning test.",
			"  A red puts the report on stderr, with GitHub ::error annotations under Actions.",
			"  7: zero scope: no patchedDependencies in scope",
			"  11: a read failed, so the verdict is UNKNOWN",
			"  12: an unpinned patch or a stale pin",
		]),
	),
	Command.withExamples([{command: "fabrika guard patch-guard check"}]),
);

const patchGuard = Command.make("patch-guard").pipe(
	Command.withSubcommands([patchCheck]),
	Command.withShortDescription("Every maintained pnpm patch is pinned by a behavior test."),
	Command.withDescription(
		"A `pnpm patch` forks a dependency's behaviour silently, so the rule requires a behaviour-pinning test and this guard is its forcing function: an unpinned patch is a fork nothing verifies, and a pin left behind after the patch moved is a test guarding nothing.",
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
		leafHelp("pointer-guard check", [
			"Prints a one-line all-clear when every backticked path in a tracked CLAUDE.md resolves.",
			"  A red puts a file:line → path report on stderr, with ::error annotations under Actions.",
			"  7: zero scope: no tracked CLAUDE.md",
			"  11: git could not list the docs, or one could not be read (UNKNOWN)",
			"  12: a pointer does not resolve",
		]),
	),
	Command.withExamples([{command: "fabrika guard pointer-guard check"}]),
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
		leafHelp("publish-isolation-guard check", [
			"Prints a one-line all-clear when every published package depends only on published packages.",
			"  A red puts the report on stderr, with GitHub ::error annotations under Actions.",
			"  7: zero scope: no published package, or an arm names no single member",
			"  11: a manifest could not be read or does not parse (UNKNOWN)",
			"  12: a published package links a private or workspace dependency",
		]),
	),
	Command.withExamples([{command: "fabrika guard publish-isolation-guard check"}]),
);

const publishIsolationGuard = Command.make("publish-isolation-guard").pipe(
	Command.withSubcommands([publishIsolationCheck]),
	Command.withShortDescription("Every published package installs from a clean registry."),
	Command.withDescription(
		"A published artifact may depend only on what a clean registry can resolve. Publishing is green whatever the dependency graph says, so the failure lands on whoever installs the package rather than on the release — which is why it is a gate rather than a review item.",
	),
);

/**
 * The one leaf in this group that is not `check`: its scope is the CHANGE, so the caller resolves
 * the diff and hands the file list in. `atLeast(0)` rather than `atLeast(1)` on purpose — a
 * zero-file invocation must reach the verb and red there, not bounce off the parser's
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
		leafHelp("leak-guard scan", [
			"Prints a one-line all-clear with its scope when no handed file holds a machine-local path.",
			"  It scans markdown docs and .sh scripts and scopes itself, so hand it every changed file.",
			"  A red puts the report on stderr, with GitHub ::error annotations under Actions.",
			"  7: zero scope: an empty file list",
			"  11: a handed file exists and could not be read (UNKNOWN)",
			"  12: a machine-local path is in a scanned surface",
		]),
	),
	Command.withExamples([{command: "fabrika guard leak-guard scan docs/guide.md scripts/run.sh"}]),
);

const leakGuard = Command.make("leak-guard").pipe(
	Command.withSubcommands([leakScan]),
	Command.withShortDescription("No machine-local path reaches a shared artifact."),
	Command.withDescription(
		"CI is the only surface that sees every change's diff whatever wrote it, so it — not a write-time hook — is the unbypassable gate for the no-machine-local-paths rule.",
	),
);

const pathFilterCheck = leafCommand(
	"check",
	{root: rootFlag},
	Effect.fn(function* ({root}) {
		yield* emit(
			yield* runPathFilterGuard({
				root: Option.getOrNull(root),
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription(
		"Red when ci.yml's e2e filter and deploy.yml's deploy filter drift.",
	),
	Command.withDescription(
		leafHelp("path-filter-guard check", [
			"Prints a one-line all-clear when ci.yml's e2e and deploy.yml's deploy path filters agree.",
			"  A red puts the report on stderr, with GitHub ::error annotations under Actions.",
			"  7: zero scope: a missing file, job, step or key, or an empty list",
			"  11: a workflow could not be read (UNKNOWN)",
			"  12: the globs or the diff basis drifted",
		]),
	),
	Command.withExamples([{command: "fabrika guard path-filter-guard check"}]),
);

const pathFilterGuard = Command.make("path-filter-guard").pipe(
	Command.withSubcommands([pathFilterCheck]),
	Command.withShortDescription("deploy's run-set stays a superset of e2e's."),
	Command.withDescription(
		"A PR that trips e2e but skips its deploy leaves e2e polling ten minutes for a preview that never arrives, and the required aggregate reds on a defect-free change. Neither workflow's own diff shows the other half, so the pairing is guarded rather than left to a reviewer's memory.",
	),
);

const changeDetectCheck = leafCommand(
	"check",
	{root: rootFlag},
	Effect.fn(function* ({root}) {
		yield* emit(
			yield* runChangeDetectGuard({
				root: Option.getOrNull(root),
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Red when ci.yml's change detection reads the GitHub API."),
	Command.withDescription(
		leafHelp("change-detect-guard check", [
			"Prints a one-line all-clear when ci.yml's changes job detects files with git diff, not the API.",
			"  A red puts the report on stderr, with GitHub ::error annotations under Actions.",
			"  7: zero scope: no changes job, paths-filter step or with: block",
			"  11: ci.yml could not be read (UNKNOWN)",
			"  12: the step is in API mode",
		]),
	),
	Command.withExamples([{command: "fabrika guard change-detect-guard check"}]),
);

const changeDetectGuard = Command.make("change-detect-guard").pipe(
	Command.withSubcommands([changeDetectCheck]),
	Command.withShortDescription("Change detection stays API-free git mode."),
	Command.withDescription(
		"The one input that decides whether CI's change detection reads the GitHub API is a `token:` the action silently defaults. Losing the empty pin reopens a flake that reds green PRs, and nothing about the diff would say so.",
	),
);

const codeownersCpCheck = leafCommand(
	"check",
	{root: rootFlag},
	Effect.fn(function* ({root}) {
		yield* emit(
			yield* runCodeownersCpGuard({
				root: Option.getOrNull(root),
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Red on a §CP control-plane path with no CODEOWNERS owner."),
	Command.withDescription(
		leafHelp("codeowners-cp check", [
			"Prints a one-line all-clear when every §CP control-plane path has a covering CODEOWNERS row.",
			"  A red names every uncovered path on stderr, with ::error annotations under Actions.",
			"  7: zero scope: no CODEOWNERS, no owned rows, or a boundary with no paths",
			"  11: CODEOWNERS could not be read (UNKNOWN)",
			"  12: a §CP path is unowned",
		]),
	),
	Command.withExamples([{command: "fabrika guard codeowners-cp check"}]),
);

const codeownersCpGuard = Command.make("codeowners-cp").pipe(
	Command.withSubcommands([codeownersCpCheck]),
	Command.withShortDescription("Every §CP path is owned in CODEOWNERS."),
	Command.withDescription(
		"A pattern set and a literal enumeration of the same paths drift silently, and here the drift is one-directional in the dangerous way: a §CP path added to the boundary without a CODEOWNERS row is control-plane by law and auto-mergeable in fact.",
	),
);

const decisionsIndexValidate = leafCommand(
	"validate",
	{root: rootFlag},
	Effect.fn(function* ({root}) {
		yield* emit(
			yield* runDecisionsIndexGuard({
				root: Option.getOrNull(root),
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Red on a duplicate ADR id or a filename/frontmatter mismatch."),
	Command.withDescription(
		leafHelp("decisions-index validate", [
			"Prints a one-line all-clear when every ADR's filename matches its id and no id repeats.",
			"  A repo declaring decisionsDir: null keeps no corpus, so the guard is skipped as a success.",
			"  A red puts the report on stderr, with GitHub ::error annotations under Actions.",
			"  7: zero scope: the declared corpus directory is missing or empty",
			"  11: a record or .fabrika.jsonc could not be read (UNKNOWN)",
			"  12: a defect",
		]),
	),
	Command.withExamples([{command: "fabrika guard decisions-index validate"}]),
);

const decisionsIndexGuard = Command.make("decisions-index").pipe(
	Command.withSubcommands([decisionsIndexValidate]),
	Command.withShortDescription("The ADR corpus holds no colliding or mismatched number."),
	Command.withDescription(
		"ADR discovery is ambient — the `NNNN-slug` filenames are the map — so a number that means two things breaks every citation of it at once, and neither branch that minted it could have seen the other.",
	),
);

const designTokenCheck = leafCommand(
	"check",
	{
		root: rootFlag,
		"write-baseline": Flag.boolean("write-baseline").pipe(
			Flag.withDefault(false),
			Flag.withDescription("re-snapshot the raw-px ceilings from this tree instead of judging it"),
		),
	},
	Effect.fn(function* ({root, "write-baseline": writeBaseline}) {
		yield* emit(
			yield* runDesignTokenGuard({
				root: Option.getOrNull(root),
				cwd: process.cwd(),
				env: process.env,
				writeBaseline,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Red on a dead token ref, a raw hex, or an off-grid px."),
	Command.withDescription(
		leafHelp("design-token-guard check", [
			"Prints a one-line all-clear when component CSS has no dead token ref, raw hex or off-grid px.",
			"  A red puts the report on stderr, with GitHub ::error annotations under Actions.",
			"  7: zero scope: no CSS file, or a malformed allow-list config",
			"  11: a read failed, so the verdict is UNKNOWN",
			"  12: the token layer is bypassed",
		]),
	),
	Command.withExamples([{command: "fabrika guard design-token-guard check"}]),
);

const designTokenGuard = Command.make("design-token-guard").pipe(
	Command.withSubcommands([designTokenCheck]),
	Command.withShortDescription("Component CSS consumes the design-token seam."),
	Command.withDescription(
		"Every failure this catches is silent in the browser: a dead token ref renders unstyled, a raw hex renders the wrong colour in one theme, an off-grid px renders slightly wrong everywhere. None of them throws, so none of them is caught by anything but a gate.",
	),
);

const i18nCheck = leafCommand(
	"check",
	{root: rootFlag},
	Effect.fn(function* ({root}) {
		yield* emit(
			yield* runI18nGuard({
				root: Option.getOrNull(root),
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Red on product copy left outside the i18n catalog."),
	Command.withDescription(
		leafHelp("i18n-guard check", [
			"Prints a one-line all-clear when no Turkish product copy sits outside the i18n catalog.",
			"  A red puts the report on stderr, with GitHub ::error annotations under Actions.",
			"  7: zero scope: no file scanned, or a malformed allow-list config",
			"  11: a read failed, so the verdict is UNKNOWN",
			"  12: Turkish copy sits outside the catalog",
		]),
	),
	Command.withExamples([{command: "fabrika guard i18n-guard check"}]),
);

const i18nGuard = Command.make("i18n-guard").pipe(
	Command.withSubcommands([i18nCheck]),
	Command.withShortDescription("Product copy reads through the i18n catalog, not a literal."),
	Command.withDescription(
		"A Turkish literal in a component is a string no locale switch can reach: the reader who picked English still sees it. The catalog is the one surface where copy lives, and this gate is what keeps the next component from re-opening the hole the migration closed.",
	),
);

const designInventoryCheck = leafCommand(
	"check",
	{root: rootFlag},
	Effect.fn(function* ({root}) {
		yield* emit(
			yield* runDesignInventoryCheck({
				root: Option.getOrNull(root),
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Red when the committed component inventory has gone stale."),
	Command.withDescription(
		leafHelp("design-inventory check", [
			"Prints a one-line all-clear when design-system-inventory.md matches the extracted inventory.",
			"  A red puts the report on stderr, with GitHub ::error annotations under Actions.",
			"  7: zero scope: no annotated primitive discovered",
			"  11: a read failed, so the verdict is UNKNOWN",
			"  12: the inventory is stale or missing",
		]),
	),
	Command.withExamples([{command: "fabrika guard design-inventory check"}]),
);

const designInventoryGenerate = leafCommand(
	"generate",
	{root: rootFlag},
	Effect.fn(function* ({root}) {
		yield* emit(
			yield* runDesignInventoryGenerate({
				root: Option.getOrNull(root),
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Rewrite the descriptive component inventory from the JSDoc."),
	Command.withDescription(
		leafHelp("design-inventory generate", [
			"Rewrites design-system-inventory.md and prints the file written and its primitive count.",
			"  7: zero scope: no annotated primitive",
			"  11: a source could not be read, or the write did not land (UNKNOWN)",
		]),
	),
	Command.withExamples([{command: "fabrika guard design-inventory generate"}]),
);

const designInventoryGuard = Command.make("design-inventory").pipe(
	Command.withSubcommands([designInventoryCheck, designInventoryGenerate]),
	Command.withShortDescription("The descriptive component inventory stays fresh and descriptive."),
	Command.withDescription(
		"The descriptive/normative firewall: the component inventory is machine-extracted and must stay current, while the design law beside it is founder-authored and must never be machine-written. The two commands travel together — a `generate` that no longer matches `check` reds CI on a file no command can fix.",
	),
);

/**
 * The registered guards, each row carrying its **local-tree membership** beside the registration.
 *
 * One appended row per port; the order is the `--help` order. The second field is the contract:
 * `localTree` says `build check` runs this guard over the checked-out tree under the named leaf,
 * `notLocalTree` says which clause of the predicate it fails. Membership is answered here and
 * nowhere else, so adding a guard is where the question gets asked.
 */
const registry = [
	localTree(readmeGuard, "check", (o) =>
		runReadmeGuard({
			root: o.root,
			cwd: o.root,
			env: o.env,
			scope: {_tag: "Change", paths: o.changed},
		}),
	),
	localTree(skillLint, "check", (o) => runSkillLint({root: o.root, cwd: o.root, env: o.env})),
	notLocalTree(homingGuard, "reads the live board"),
	notLocalTree(pitchGuard, "reads the live board and resolves approval at the repository ACL"),
	notLocalTree(roadmapGuard, "projects the repository's milestones off the API"),
	notLocalTree(unresolvedThreadsGuard, "takes a pull-request number"),
	localTree(settingsEnvGuard, "check", (o) =>
		runSettingsEnvGuard({root: o.root, cwd: o.root, env: o.env}),
	),
	localTree(catalogGuard, "check", (o) => runCatalogGuard({root: o.root, cwd: o.root, env: o.env})),
	localTree(fanoutGuard, "check", (o) => runFanoutGuard({root: o.root, cwd: o.root, env: o.env})),
	localTree(patchGuard, "check", (o) => runPatchGuard({root: o.root, cwd: o.root, env: o.env})),
	localTree(pointerGuard, "check", (o) => runPointerGuard({root: o.root, cwd: o.root, env: o.env})),
	localTree(publishIsolationGuard, "check", (o) =>
		runPublishIsolationGuard({root: o.root, cwd: o.root, env: o.env}),
	),
	notLocalTree(leakGuard, "takes the changed files as arguments"),
	localTree(pathFilterGuard, "check", (o) =>
		runPathFilterGuard({root: o.root, cwd: o.root, env: o.env}),
	),
	localTree(changeDetectGuard, "check", (o) =>
		runChangeDetectGuard({root: o.root, cwd: o.root, env: o.env}),
	),
	localTree(codeownersCpGuard, "check", (o) =>
		runCodeownersCpGuard({root: o.root, cwd: o.root, env: o.env}),
	),
	localTree(decisionsIndexGuard, "validate", (o) =>
		runDecisionsIndexGuard({root: o.root, cwd: o.root, env: o.env}),
	),
	localTree(designTokenGuard, "check", (o) =>
		runDesignTokenGuard({root: o.root, cwd: o.root, env: o.env, writeBaseline: false}),
	),
	localTree(designInventoryGuard, "check", (o) =>
		runDesignInventoryCheck({root: o.root, cwd: o.root, env: o.env}),
	),
	localTree(i18nGuard, "check", (o) => runI18nGuard({root: o.root, cwd: o.root, env: o.env})),
	localTree(noGhGuard, "check", (o) => runNoGh({root: o.root, cwd: o.root, env: o.env})),
	localTree(portabilityGuard, "check", (o) =>
		runPortabilityGuard({root: o.root, cwd: o.root, env: o.env}),
	),
];

const guards = registry.map((row) => row.command);

/**
 * The set `build check` sweeps, derived from {@link registry} — never a list of its own.
 *
 * Exported for `build/command.ts`, which hands it to the check verb. The verb takes it as an
 * operand rather than importing it, so a test names the guards it means.
 */
export const localTreeGuards: ReadonlyArray<LocalTreeGuard> = membersOf(registry);

export const guardCommand = Command.make("guard").pipe(
	Command.withSubcommands(guards),
	Command.withShortDescription("Run one of the repo's fail-closed CI gates."),
	Command.withDescription(
		"Run one of the repo's fail-closed CI gates: `fabrika guard <name> check`. Every guard scopes itself from the workspace or the change, reds on a violation, and reds on zero scope rather than passing vacuously",
	),
);
