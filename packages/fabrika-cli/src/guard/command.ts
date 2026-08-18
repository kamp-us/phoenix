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
import {runReadmeGuard} from "./readme-verb.ts";
import {runSkillLint} from "./skill-lint-verb.ts";

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

/** The registered guards. One appended row per port; the order is the `--help` order. */
const guards = [readmeGuard, skillLint];

export const guardCommand = Command.make("guard").pipe(
	Command.withSubcommands(guards),
	Command.withShortDescription("Run one of the repo's fail-closed CI gates."),
	Command.withDescription(
		"Run one of the repo's fail-closed CI gates: `fabrika guard <name> check`. Every guard scopes itself from the workspace or the change, reds on a violation, and reds on zero scope rather than passing vacuously (ADR 0092)",
	),
);
